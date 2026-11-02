import test from 'node:test'
import { baselineFixture as legacyFixture, baselineChildSpec as childSpec, loadBaselineModule } from './legacy-baseline.js'
import { captureLocalLegacy, prepareLegacyMigration, applyLegacyMigration } from '../src/framework/legacy-migration.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ExecutionControls } from '../src/framework/execution-control.js'
import { FrameworkService } from '../src/framework/service.js'
import { paths } from '../src/framework/task-files.js'
import { LocalFiles } from '../src/framework/local-files.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
import { FrameworkConversation } from '../src/framework/conversation.js'
import { withSnapshot, FilesConflictError, FilesOutcomeUnknownError } from '../src/framework/transactions.js'
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
      runtime: { workerSeats: registration.workerSeats, updateWorkerSeats(seats: number) { this.workerSeats = seats }, invalidateSkills: () => { lifecycle.invalidations++ }, controls: new ExecutionControls(storage, mode), applyUserControls: async () => {}, resumeTask: async () => {}, requestExecutionStop: async () => {}, conversation: new FrameworkConversation(files, transactions, { mode, collaborationId: internal.saved.get(mode).settings.collaborationId }), executionViews: () => [], dispose: async () => { lifecycle.disposes++ } }, resources: [{ member: 'Offline-1', availability: 'offline', instanceUUID: 'old-instance', workerSeats: 2 }] }
  }
  for (const mode of ['local', 'git'] as const) { internal.saved.set(mode, { revision: mode + '-settings', settings: { ...settings } }); internal.running.set(mode, running(mode)) }
  internal.open = async (mode: 'local' | 'git') => { lifecycle.opens++; const active = running(mode); internal.running.set(mode, active); return active }
  const realAccess = internal.access.bind(internal)
  internal.access = (mode: 'local' | 'git') => { if (internal.closed) return realAccess(mode); assert.ok(internal.accesses.has(mode), 'test access must not reach native authentication or external storage'); return realAccess(mode) }
  return { service, local, gitSeam, lifecycle, storage }
}
const input = (mode: 'local' | 'git', id: string): FrameworkSendInput => ({ mode, collaborationId: 'team', storageScope: mode, id, createdAt: '2026-10-31T12:00:00.000Z', text: 'Original service text 😀\n', recipient: 'ai', device: 'test-browser', timezoneOffsetMinutes: 540 })

test('actual service sends through SQLite transaction and conversation; state/history survive mode selection', async t => {
  const { service, local, gitSeam } = await fixture(t)
  await service.send(input('local', 'one')); await service.send(input('git', 'two'))
  await withSnapshot(local, async snapshot => assert.equal((await local.listDirectory(snapshot, 'state/')).length, 1))
  await withSnapshot(gitSeam, async snapshot => assert.equal((await gitSeam.listDirectory(snapshot, 'state/')).length, 1))
  assert.deepEqual((await service.view({ mode: 'local' })).messages.map(message => message.id), ['one'])
  assert.deepEqual((await service.selectMode({ mode: 'git' })).messages.map(message => message.id), ['two'])
  assert.deepEqual((await service.history({ mode: 'local', collaborationId: 'team', limit: 10 })).messages.map(message => message.id), ['one'])
  assert.equal((await service.view({ mode: 'git' })).resources[0].status, 'offline')
})
test('text and binary read/download return original durable bytes without a synthetic response', async t => {
  const { service, local } = await fixture(t), binary = Uint8Array.from([0xff, 0, 0xfe, 3])
  await withSnapshot(local, snapshot => local.commit(snapshot, [{ path: 'archives/T/records.md', content: 'Recorder text 😀' }, { path: 'archives/T/image.bin', bytes: binary }], 'fixture outputs'))
  assert.equal((await service.readFile({ mode: 'local', path: 'archives/T/records.md' })).text, 'Recorder text 😀')
  const result = await service.readFile({ mode: 'local', path: 'archives/T/image.bin' })
  assert.equal(result.binary?.sha256, createHash('sha256').update(binary).digest('hex'))
  assert.equal(result.binary?.bytes, binary.length)
  assert.match(result.binary!.downloadUrl, /mode=local/)
  assert.deepEqual(await service.download('local', 'archives/T/image.bin'), binary)
})
test('archive discovery exposes retained outputs by exact Task without scanning or reading bodies on ordinary views', async t => {
  const { service, local } = await fixture(t), binary = Uint8Array.from([255, 0, 254, 17])
  await withSnapshot(local, snapshot => local.commit(snapshot, [
    { path: 'archives/T/records.md', content: 'Recorder summary' },
    { path: 'archives/T/results/note.txt', content: 'Retained result 😀' },
    { path: 'archives/T/image.bin', bytes: binary },
    { path: 'archives/T/retention.json', content: '{}' },
    { path: 'archives/T2/records.md', content: 'Other Task' },
    { path: 'archives/T2/other.bin', bytes: binary },
    { path: 'task-runs/T/Worker_1_Reply.md', content: 'temporary' },
  ], 'archive outputs'))
  await withSnapshot(local, snapshot => local.commit(snapshot, [{ path: 'task-runs/T/Worker_1_Reply.md', content: null }], 'cleanup runtime material'))
  const scans: string[] = [], list = local.list.bind(local)
  local.list = async (snapshot, prefix) => { scans.push(prefix); return list(snapshot, prefix) }
  const archives = (await service.view({ mode: 'local', includeArchives: true })).archives
  assert.deepEqual(archives.find(row => row.taskId === 'T')?.files, ['archives/T/image.bin', 'archives/T/results/note.txt'])
  assert.deepEqual(archives.find(row => row.taskId === 'T2')?.files, ['archives/T2/other.bin'])
  assert.deepEqual((await service.view({ mode: 'local' })).archives, archives)
  assert.deepEqual(scans, ['archives/'])
  assert.equal((await service.readFile({ mode: 'local', path: archives[0].files![1] })).text, 'Retained result 😀')
  assert.deepEqual([...await service.download('local', 'archives/T/results/note.txt')], [...new TextEncoder().encode('Retained result 😀')])
  assert.deepEqual(await service.download('local', 'archives/T/image.bin'), binary)
})
test('human discussion is durable with no Foreground signal and no other-mode text', async t => {
  const { service, local } = await fixture(t)
  await service.send({ ...input('local', 'human'), recipient: 'human' })
  await withSnapshot(local, async snapshot => assert.equal((await local.listDirectory(snapshot, 'state/')).length, 0))
  assert.equal((await service.view({ mode: 'local' })).messages[0].recipient, 'human')
  assert.equal((await service.view({ mode: 'git' })).messages.length, 0)
})
test('same confirmed settings command is idempotent and does not dispose a live runtime again', async t => {
  const { service, lifecycle } = await fixture(t)
  const command = { mode: 'local' as const, commandId: 'settings-once', expectedRevision: 'local-settings', settings: { ...settings, name: 'Renamed' } }
  const first = await service.configure(command), calls = { ...lifecycle }
  const second = await service.configure(command)
  assert.equal(second.revision, first.revision)
  assert.deepEqual(lifecycle, calls)
  assert.equal((await service.view({ mode: 'git' })).settings.name, 'DSS')
})
test('send re-evaluates after a proven CAS conflict while preserving the same message ID', async t => {
  const { service, local } = await fixture(t), commit = local.commit.bind(local)
  let conflict = true
  local.commit = async (snapshot, changes, message) => {
    if (conflict) { conflict = false; await withSnapshot(local, current => commit(current, [{ path: 'concurrent.txt', content: 'new H' }], 'concurrent')); throw new FilesConflictError(snapshot.revision) }
    return commit(snapshot, changes, message)
  }
  await assert.rejects(service.send(input('local', 'conflicted')), FilesConflictError)
  await service.send(input('local', 'conflicted'))
  assert.deepEqual((await service.view({ mode: 'local' })).messages.map(message => message.id), ['conflicted'])
})

test('ordinary view never discovers archive tree; explicit archive view caches metadata for later ordinary reads', async t => {
  const { service, local } = await fixture(t), scans: string[] = [], list = local.list.bind(local)
  await withSnapshot(local, snapshot => local.commit(snapshot, [{ path: 'archives/T/records.md', content: 'actual archive' }], 'archive fixture'))
  local.list = async (snapshot, prefix) => { scans.push(prefix); return list(snapshot, prefix) }
  assert.deepEqual((await service.view({ mode: 'local' })).archives, [])
  assert.deepEqual(scans, [])
  assert.equal((await service.view({ mode: 'local', includeArchives: true })).archives[0].taskId, 'T')
  assert.deepEqual(scans, ['archives/'])
  assert.equal((await service.view({ mode: 'local' })).archives[0].taskId, 'T')
  assert.deepEqual(scans, ['archives/'])
})
test('configuration switching physical storage does not expose archive metadata from previous storage', async t => {
  const { service, local, storage } = await fixture(t)
  await withSnapshot(local, snapshot => local.commit(snapshot, [{ path: 'archives/old-private-task/records.md', content: 'old root archive' }], 'old archive'))
  await service.view({ mode: 'local', includeArchives: true })
  const root = await mkdtemp(join(tmpdir(), 'dss-new-root-')), replacement = await LocalFiles.open(root)
  t.after(async () => { await replacement.close(); await rm(root, { recursive: true, force: true }) })
  const internal = service as any
  internal.open = async () => {
    const active = { connection: { files: replacement, registration: { member: 'New-1' }, close: async () => {} }, runtime: { controls: new ExecutionControls(storage, 'new-root'), applyUserControls: async () => {}, resumeTask: async () => {}, requestExecutionStop: async () => {}, conversation: new FrameworkConversation(replacement, new FrameworkTransactions(replacement, storage, 'new-root'), { mode: 'local', collaborationId: 'new-team' }), executionViews: () => [], dispose: async () => {} }, resources: [] }
    internal.accesses.set('local', Promise.resolve({ connection: { files: replacement, identity: { login: 'New', owner: 'New', repositoryId: 'new-root', instanceUUID: '00000000-0000-4000-8000-000000000003' }, prepareWrite: async () => {}, close: async () => {} }, conversation: active.runtime.conversation }))
    internal.running.set('local', active); return active
  }
  const next = await service.configure({ mode: 'local', commandId: 'move-root', expectedRevision: 'local-settings', settings: { ...settings, localDirectory: root, collaborationId: 'new-team' } })
  assert.deepEqual(next.archives, [])
})

test('client timezone offsets reach real Foreground signal names for UTC+9 and UTC+5:30', async t => {
  const { service, local } = await fixture(t)
  await service.send({ ...input('local', 'japan'), timezoneOffsetMinutes: 540 })
  await service.send({ ...input('local', 'india'), timezoneOffsetMinutes: 330 })
  await withSnapshot(local, async snapshot => {
    const notifications = (await local.listDirectory(snapshot, 'state/')).map(entry => entry.path)
    assert.ok(notifications.some(path => path.includes('-GMT9-20261031-210000000')))
    assert.ok(notifications.some(path => path.includes('-GMT5m30-20261031-173000000')))
  })
})
test('Git conversation records use authenticated account identity, not registered device member', async t => {
  const { service } = await fixture(t)
  await service.send(input('git', 'identity'))
  assert.equal((await service.history({ mode: 'git', collaborationId: 'team', limit: 10 })).messages[0].participantId, '42')
})

test('leaving participation keeps storage/history/chat usable without reopening runtime or another mode', async t => {
  const { service, local, lifecycle } = await fixture(t)
  await withSnapshot(local, snapshot => local.commit(snapshot, [{ path: 'archives/T/records.md', content: 'read after leaving' }], 'retained output'))
  const left = await service.participation({ mode: 'local', enabled: false })
  assert.equal(left.connection.participating, false)
  const afterStop = { ...lifecycle }
  await service.send(input('local', 'after-stop'))
  assert.equal((await service.history({ mode: 'local', collaborationId: 'team', limit: 10 })).messages[0].id, 'after-stop')
  assert.equal((await service.readFile({ mode: 'local', path: 'archives/T/records.md' })).text, 'read after leaving')
  assert.equal((await service.view({ mode: 'local' })).connection.participating, false)
  assert.equal((await service.selectMode({ mode: 'git' })).connection.participating, true)
  await service.selectMode({ mode: 'local' })
  assert.deepEqual(lifecycle, afterStop)
  assert.equal((await service.participation({ mode: 'local', enabled: true })).connection.participating, true)
  assert.equal(lifecycle.opens, afterStop.opens + 1)
})

for (const withScope of [true, false]) test(`unknown original message cannot be rebound into another physical store (scope field ${withScope})`, async t => {
  const { service, local, gitSeam, storage } = await fixture(t), internal = service as any
  local.commit = async () => { throw new FilesOutcomeUnknownError('original-operation') }
  const original = { ...input('local', 'unknown-destination'), storageScope: withScope ? 'local' : undefined }
  await assert.rejects(service.send(original), FilesOutcomeUnknownError)
  const replacement = { connection: { files: gitSeam, transactions: new FrameworkTransactions(gitSeam, storage, 'other-root'), scope: 'another-local-root', identity: { login: 'User', owner: 'User', repositoryId: 'other-root', instanceUUID: '00000000-0000-4000-8000-000000000004' }, prepareWrite: async () => {}, close: async () => {} }, conversation: new FrameworkConversation(gitSeam, new FrameworkTransactions(gitSeam, storage, 'other-root'), { mode: 'local', collaborationId: 'team' }) }
  internal.accesses.set('local', Promise.resolve(replacement))
  await assert.rejects(service.send(original), /scope|destination|storage|target/i)
  await withSnapshot(gitSeam, async snapshot => assert.equal((await gitSeam.list(snapshot, 'conversations/')).length, 0))
})

test('actual legacy capture/migration becomes discoverable in service view and opens complete original records', async t => {
  const old = await legacyFixture('Original task body with details 😀\nPreserve every line')
  assert.equal((await old.execute({ type: 'task.control', intent: 'pause' }, { kind: 'user', id: 'owner' })).status, 'applied')
  const { service, local, storage } = await fixture(t), capture = await captureLocalLegacy(old.storage)
  const plan = await withSnapshot(local, snapshot => prepareLegacyMigration(capture, local, snapshot, { id: 'service-upgrade', owner: 'User-1', members: { assistant: 'User-1' } }))
  await applyLegacyMigration(local, new FrameworkTransactions(local, storage, 'migration-service-test'), plan)
  const page = await service.view({ mode: 'local', includeArchives: true })
  const item = page.legacyTasks.find(item => item.oldTaskId === 'one')
  assert.ok(item, 'actual service view exposes the imported paused task, not only a private manifest')
  assert.equal(item.continuation, 'paused')
  const document = await service.readFile({ mode: 'local', path: item.recordPath })
  assert.deepEqual(JSON.parse(document.text!), await old.get())
  const resumed = await service.legacyControl({ mode: 'local', storageScope: 'local', commandId: 'resume-real-paused', migrationId: item.migrationId, oldTaskId: item.oldTaskId, action: 'resume' })
  assert.equal(resumed.legacyTasks.find(task => task.oldTaskId === 'one')?.continuation, 'running')
  assert.ok(resumed.tasks.some(task => task.taskId === item.taskId))
  await withSnapshot(local, async snapshot => assert.match((await local.read(snapshot, paths.inbox(item.taskId, 'User-1')))!, /resume-real-paused/))
  assert.equal((await old.get()).control, 'paused', 'migration control does not revive or mutate the retired engine')
})

test('changing model preferences within the same storage scope keeps the original retained-message destination', async t => {
  const { service, local } = await fixture(t), commit = local.commit.bind(local)
  let unknown = true
  local.commit = async (...args) => { if (unknown) { unknown = false; throw new FilesOutcomeUnknownError('model-change-pending') } return commit(...args) }
  const original = input('local', 'before-model-change')
  await assert.rejects(service.send(original), FilesOutcomeUnknownError)
  await service.configure({ mode: 'local', commandId: 'model-only', expectedRevision: 'local-settings', settings: { ...settings, foreground: { provider: 'controlled', model: 'selected' } } })
  await service.send(original)
  assert.equal((await service.history({ mode: 'local', collaborationId: 'team', storageScope: 'local', limit: 10 })).messages[0].id, original.id)
})

test('actual legacy user wait exposes its question and explicit answer enters restored member Inbox', async t => {
  const old = await legacyFixture('Actual waiting task'), planner = await old.bind('plan')
  assert.equal((await old.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 0, strategy: 'Wait for exact source selection', children: [childSpec()] }, planner.source)).status, 'applied')
  const worker = await old.bind('dispatch')
  assert.equal((await old.execute({ type: 'execution.report', report: { resultId: 'waiting-result', assignmentVersion: 1, outcome: 'wait', wait: { id: 'source-question', kind: 'user', reason: 'Source unspecified', condition: 'Receive selected source', resume: 'Use selected source', question: 'Which exact source should I use?' }, summary: 'Awaiting source', artifacts: [], evidence: ['User choice required'], frontier: 'Continue with answer' } }, worker.source)).status, 'applied')
  const { service, local, storage } = await fixture(t), capture = await captureLocalLegacy(old.storage)
  const plan = await withSnapshot(local, snapshot => prepareLegacyMigration(capture, local, snapshot, { id: 'wait-upgrade', owner: 'User-1', members: { assistant: 'User-1' } }))
  await applyLegacyMigration(local, new FrameworkTransactions(local, storage, 'wait-migration'), plan)
  const item = (await service.view({ mode: 'local' })).legacyTasks.find(task => task.oldTaskId === 'one')!
  assert.equal(item.continuation, 'wait-user')
  assert.equal(item.waits?.[0].id, 'source-question')
  assert.equal(item.waits?.[0].question, 'Which exact source should I use?')
  await assert.rejects(service.legacyControl({ mode: 'local', storageScope: 'local', commandId: 'incorrect-question', migrationId: item.migrationId, oldTaskId: item.oldTaskId, action: 'answer', waitId: 'not-the-question', answer: 'Source A' }), /question|pending/i)
  const page = await service.legacyControl({ mode: 'local', storageScope: 'local', commandId: 'answer-exact-question', migrationId: item.migrationId, oldTaskId: item.oldTaskId, action: 'answer', waitId: 'source-question', answer: 'Source A, preserving exact user text' })
  assert.equal(page.legacyTasks.find(task => task.oldTaskId === 'one')?.continuation, 'running')
  await withSnapshot(local, async snapshot => {
    const inbox = (await local.read(snapshot, paths.inbox(item.taskId, 'User-1')))!
    assert.match(inbox, /Source A, preserving exact user text/); assert.match(inbox, /source-question/)
  })
})

test('real service persists Host task controls, rejects completed/foreign tasks and does not replay stale resume', async t => {
  const { service, local } = await fixture(t), runtime = (service as any).running.get('local').runtime
  const resumes: string[] = []; const applied: unknown[][] = []
  runtime.applyUserControls = async (...args: unknown[]) => { applied.push(args) }
  runtime.resumeTask = async (taskId: string) => { resumes.push(taskId) }
  await withSnapshot(local, snapshot => local.commit(snapshot, [
    { path: paths.task('T'), content: JSON.stringify({ version: 1, taskId: 'T', route: 'P', owner: 'User-1', sourcePath: 'tasks/task_P.md', status: 'running' }) },
    { path: paths.task('C'), content: JSON.stringify({ version: 1, taskId: 'C', route: 'P', owner: 'User-1', sourcePath: 'tasks/done_P.md', status: 'complete' }) },
    { path: paths.task('F'), content: JSON.stringify({ version: 1, taskId: 'F', route: 'P', owner: 'Other-1', sourcePath: 'tasks/foreign_P.md', status: 'running' }) },
  ], 'test task metadata'))
  const base = { mode: 'local' as const, storageScope: 'local', taskId: 'T' }
  await service.taskControl({ ...base, commandId: 'resume', intent: 'running' })
  await service.taskControl({ ...base, commandId: 'pause', intent: 'paused' })
  await service.taskControl({ ...base, commandId: 'resume', intent: 'running' })
  assert.deepEqual(resumes, ['T']); assert.deepEqual(applied, Array.from({ length: 3 }, () => [true, { taskId: 'T' }]))
  assert.equal((await service.view({ mode: 'local' })).tasks.find(task => task.taskId === 'T')?.control, 'paused')
  await assert.rejects(service.taskControl({ ...base, taskId: 'C', commandId: 'complete', intent: 'running' }), /completed/)
  await assert.rejects(service.taskControl({ ...base, taskId: 'F', commandId: 'foreign', intent: 'paused' }), /execution domain/)
  const stops: unknown[] = []
  runtime.requestExecutionStop = async (...args: unknown[]) => { stops.push(args); if (args[2] !== 'owned-exec') throw new Error('execution not owned') }
  await service.stopExecution({ mode: 'local', storageScope: 'local', commandId: 'stop', workId: 'work', executionId: 'owned-exec' })
  await assert.rejects(service.stopExecution({ mode: 'local', storageScope: 'local', commandId: 'stop-other', workId: 'work', executionId: 'foreign-exec' }), /not owned/)
  assert.deepEqual(stops[0], ['stop', 'work', 'owned-exec'])
})

test('actual service browses UTC saved date and newer pages through real conversation metadata', async t => {
  const { service } = await fixture(t)
  for (const [id, createdAt] of [['previous', '2026-10-30T23:59:00Z'], ['early', '2026-10-31T09:00:00+09:00'], ['later', '2026-10-31T08:00:00Z'], ['next', '2026-11-01T00:00:00Z']]) {
    await service.send({ ...input('local', id), createdAt, recipient: 'human' })
  }
  const query = { mode: 'local' as const, collaborationId: 'team', storageScope: 'local', date: '2026-10-31', limit: 1 }
  const first = await service.history(query)
  assert.deepEqual(first.messages.map(message => message.id), ['later']); assert.equal(first.moreBefore, 'later'); assert.equal(first.moreAfter, undefined)
  const earlier = await service.history({ ...query, beforeId: first.moreBefore })
  assert.deepEqual(earlier.messages.map(message => message.id), ['early']); assert.equal(earlier.moreBefore, undefined); assert.equal(earlier.moreAfter, 'early')
  const second = await service.history({ ...query, afterId: earlier.moreAfter })
  assert.deepEqual(second.messages.map(message => message.id), ['later']); assert.equal(second.moreAfter, undefined)
  const previous = await service.history({ ...query, beforeId: second.moreBefore })
  assert.deepEqual(previous.messages.map(message => message.id), ['early'])
  await assert.rejects(service.history({ ...query, beforeId: 'later', afterId: 'early' }), /pagination direction/i)
  const latest = await service.view({ mode: 'local' })
  assert.deepEqual(latest.messages.map(message => message.id), ['previous', 'early', 'later', 'next'])
})

const skillPath = 'skills/verified/SKILL.md'
const skillText = '---\nname: verified\ndescription: Verified operation\n---\nOriginal active method\n'
async function seedKnowledge(files: LocalFiles) {
  const { prepareFrameworkSkillIndex } = await import('../src/framework/skills.js')
  await withSnapshot(files, async snapshot => {
    const changes = [{ path: skillPath, content: skillText }]
    await files.commit(snapshot, [...changes, ...(await prepareFrameworkSkillIndex(files, snapshot, changes)).changes], 'indexed skill fixture')
  })
}
test('knowledge service explicit list/read/edit replays one candidate without replacing active content or starting background', async t => {
  const { service, local, lifecycle } = await fixture(t)
  await seedKnowledge(local)
  await service.participation({ mode: 'local', enabled: false })
  const before = { ...lifecycle }, scope = { mode: 'local' as const, storageScope: 'local' }
  const list = await service.knowledgeList(scope)
  assert.equal(list.items[0]!.indexed, true)
  assert.equal((await service.knowledgeRead({ ...scope, path: skillPath })).text, skillText)
  const command = { ...scope, commandId: 'edit-once', path: skillPath, expectedRevision: list.revision, body: 'Candidate only 😀', createdAt: '2026-10-31T18:00:00Z' }
  const first = await service.knowledgeEdit(command)
  assert.deepEqual(await service.knowledgeEdit(command), { ...first, replay: true })
  const next = await service.knowledgeList(scope)
  assert.equal(next.items[0]!.candidates.length, 1)
  assert.equal(next.items[0]!.indexed, true)
  assert.equal((await service.knowledgeRead({ ...scope, path: skillPath })).text, skillText)
  await withSnapshot(local, async snapshot => {
    assert.equal(await local.read(snapshot, next.items[0]!.candidates[0]!.path), command.body)
    assert.deepEqual(await local.list(snapshot, 'instances/'), [])
  })
  assert.deepEqual(lifecycle, before)
  assert.equal((await service.view({ mode: 'local' })).connection.participating, false)
})

test('knowledge service disable invalidates installed official native skill directory through runtime notification seam', async t => {
  const { service, local, lifecycle } = await fixture(t)
  await seedKnowledge(local)
  const { Context } = await import('@deepseek-ai/cordis')
  const { SkillRegistry } = await import('@deepseek-ai/dsh-skill')
  const { createScope } = await import('@deepseek-ai/dsh-scope')
  const { installFrameworkSkillProvider } = await import('../src/framework/skills.js')
  const ctx = new Context(), plugin = await ctx.plugin(SkillRegistry), agent = {} as any, scoped = createScope(ctx, agent)
  const provider = installFrameworkSkillProvider(scoped.ctx, agent, local)
  await new Promise(resolve => setImmediate(resolve))
  t.after(async () => { await provider.dispose(); await scoped.dispose(); await plugin.dispose() })
  const registry = ctx.get('skills')!
  assert.equal((await registry.list({ scope: agent })).length, 1)
  // Only runtime ownership is a seam; actual provider, registry, service and SQLite execute.
  ;(service as any).running.get('local').runtime.invalidateSkills = () => { lifecycle.invalidations++; provider.invalidate() }
  const listed = await service.knowledgeList({ mode: 'local', storageScope: 'local' })
  const command = { mode: 'local' as const, storageScope: 'local', commandId: 'disable-once', path: skillPath, expectedRevision: listed.revision, status: 'disabled' as const }
  const receipt = await service.knowledgeStatus(command)
  assert.ok(lifecycle.invalidations > 0)
  assert.deepEqual(await registry.list({ scope: agent }), [])
  assert.deepEqual(await service.knowledgeStatus(command), { ...receipt, replay: true })
  assert.equal((await service.knowledgeList({ mode: 'local' })).items[0]!.status, 'disabled')
  assert.equal((await service.knowledgeRead({ mode: 'local', path: skillPath })).text, skillText)
})

test('knowledge commands retain explicit mode/scope; stale root requests never read or write replacement root', async t => {
  const { service, local, gitSeam } = await fixture(t)
  await seedKnowledge(local); await seedKnowledge(gitSeam)
  const scope = { mode: 'local' as const, storageScope: 'local' }, original = await service.knowledgeList(scope)
  await service.selectMode({ mode: 'git' })
  await service.knowledgeEdit({ ...scope, commandId: 'original-domain', path: skillPath, expectedRevision: original.revision, body: 'Local candidate', createdAt: '2026-10-31T18:00:00Z' })
  assert.equal((await service.knowledgeList({ mode: 'git', storageScope: 'git' })).items[0]!.candidates.length, 0)
  const internal = service as any, replacement = await internal.accesses.get('git')
  internal.accesses.set('local', Promise.resolve(replacement))
  await assert.rejects(service.knowledgeList(scope), /scope|storage|changed/i)
  await assert.rejects(service.knowledgeRead({ ...scope, path: skillPath }), /scope|storage|changed/i)
  await assert.rejects(service.knowledgeEdit({ ...scope, commandId: 'stale-root', path: skillPath, expectedRevision: original.revision, body: 'wrong', createdAt: '2026-10-31T18:00:00Z' }), /scope|storage|changed/i)
  await assert.rejects(service.knowledgeStatus({ ...scope, commandId: 'stale-disable', path: skillPath, expectedRevision: original.revision, status: 'disabled' }), /scope|storage|changed/i)
  assert.equal((await service.knowledgeList({ mode: 'git', storageScope: 'git' })).items[0]!.status, 'active')
})

test('ordinary service view does not scan knowledge definitions; only explicit knowledge request reads them', async t => {
  const { service, local } = await fixture(t)
  await seedKnowledge(local)
  const reads: string[] = [], scans: string[] = [], read = local.read.bind(local), list = local.list.bind(local)
  local.read = async (snapshot, path) => { reads.push(path); return read(snapshot, path) }
  local.list = async (snapshot, prefix) => { scans.push(prefix); return list(snapshot, prefix) }
  await service.view({ mode: 'local' }); await service.view({ mode: 'local' })
  assert.equal(reads.some(path => path.startsWith('skills/')), false)
  assert.equal(scans.some(path => path.startsWith('skills/')), false)
  await service.knowledgeList({ mode: 'local' })
  assert.ok(reads.includes(skillPath)); assert.ok(scans.includes('skills/'))
})

for (const failure of ['resources', 'manifest', 'task', 'combined'] as const) test(`view isolates ${failure} errors from conversation and healthy Tasks without a self-refresh loop`, async t => {
  const { service, local } = await fixture(t), internal = service as any
  await service.send({ ...input('local', 'surviving-message'), recipient: 'human' })
  await withSnapshot(local, snapshot => local.commit(snapshot, [
    { path: paths.task('healthy'), content: JSON.stringify({ version: 1, taskId: 'healthy', route: 'P', owner: 'User-1', sourcePath: 'tasks/healthy_P.md', status: 'running' }) },
    { path: 'technical/legacy-migrations/index.json', content: JSON.stringify({ migrations: [{ id: 'bad', manifestPath: 'technical/legacy-migrations/bad.json' }, { id: 'good', manifestPath: 'technical/legacy-migrations/good.json' }] }) },
    { path: 'technical/legacy-migrations/bad.json', content: failure === 'manifest' || failure === 'combined' ? '{broken manifest' : JSON.stringify({ tasks: [] }) },
    { path: 'technical/legacy-migrations/good.json', content: JSON.stringify({ tasks: [{ oldId: 'old-good', taskId: 'good-migration', continuation: 'complete', recordPath: 'archives/old-good/records.md' }] }) },
    ...(failure === 'task' || failure === 'combined' ? [{ path: paths.task('broken'), content: '{broken task' }] : []),
  ], 'independent readable and broken sections'))
  if (failure === 'resources' || failure === 'combined') {
    internal.running.delete('local')
    internal.observe = async () => { throw new Error('Resource observation unavailable') }
  }
  let changes = 0
  const unsubscribe = service.subscribeChanged(() => { changes++ })
  t.after(unsubscribe)
  const first = await service.view({ mode: 'local' })
  assert.deepEqual(first.messages.map(row => row.id), ['surviving-message'])
  assert.deepEqual(first.tasks.map(row => row.taskId), ['healthy'])
  assert.deepEqual(first.legacyTasks.map(row => row.oldTaskId), ['old-good'])
  assert.match(first.connection.detail ?? '', failure === 'resources' ? /Resource observation unavailable/ : failure === 'task' ? /Invalid Task tasks\/broken.json/ : /JSON|property|position|manifest/i)
  if (failure === 'combined') {
    assert.match(first.connection.detail ?? '', /Resource observation unavailable/)
    assert.match(first.connection.detail ?? '', /Invalid Task tasks\/broken.json/)
    assert.match(first.connection.detail ?? '', /JSON|property|position|manifest/i)
  }
  assert.ok(changes > 0, 'first visible error notifies the UI')
  const count = changes
  for (let n = 0; n < 3; n++) {
    const repeated = await service.view({ mode: 'local' })
    assert.deepEqual(repeated.messages, first.messages)
    assert.deepEqual(repeated.tasks, first.tasks)
    assert.deepEqual(repeated.legacyTasks, first.legacyTasks)
    assert.equal(repeated.connection.detail, first.connection.detail)
  }
  assert.equal(changes, count, 'persistent section failures must not make view trigger itself indefinitely')
})

for (const existingFramework of [false, true]) test(`startup preserves ${existingFramework ? 'existing framework' : 'historical UI'} Local worker seats against Host defaults`, async t => {
  const { storage } = await fixture(t)
  const baseline = await loadBaselineModule<{ RuntimeSettingsService: {
    open(storage: StoragePort, hostWorkerSeats: number): Promise<{
      get(): { schemaVersion: 1; revision: number; workerSeats: number }
      configure(revision: number, seats: number): Promise<{ schemaVersion: 1; revision: number; workerSeats: number }>
    }>
  } }>('src/application/runtime-settings.ts')
  const old = await baseline.RuntimeSettingsService.open(storage, 2)
  const historical = await old.configure(old.get().revision, 4)
  assert.deepEqual(await storage.get('settings/runtime'), { schemaVersion: 1, revision: 2, workerSeats: 4 })
  // Startup migration only: both participation flags are explicit and the Git
  // framework settings already exist, so no connection/authentication is needed.
  await storage.set('framework-participation/local', false)
  await storage.set('framework-participation/git', false)
  await storage.set('framework-settings/git', { revision: 'saved-git', settings: { ...settings, workerSeats: 7 } })
  if (existingFramework) await storage.set('framework-settings/local', { revision: 'saved-local', settings: { ...settings, workerSeats: 6 } })
  const service = new FrameworkService({} as any, storage, { ...settings, workerSeats: 2 }), internal = service as any
  internal.access = async () => { throw new Error('No storage/credential connection authorized in this migration test') }
  internal.connect = async () => { assert.fail('Startup must honor explicit non-participation') }
  internal.open = async () => { assert.fail('No native runtime should start') }
  await service.start()
  const saved = await storage.get<{ revision: string; settings: FrameworkClientSettings }>('framework-settings/local')
  assert.equal(saved?.settings.workerSeats, existingFramework ? 6 : 4)
  if (existingFramework) assert.equal(saved?.revision, 'saved-local')
  assert.equal(internal.saved.get('local').settings.workerSeats, existingFramework ? 6 : 4)
  assert.deepEqual(await storage.get('settings/runtime'), historical, 'migration must not rewrite historical persisted input')
  assert.equal((await storage.get<{ settings: FrameworkClientSettings }>('framework-settings/git'))?.settings.workerSeats, 7)
})

for (const edit of ['worker-seats', 'display-preferences'] as const) test(`same execution scope ${edit} edit must preserve live role ownership instead of restarting`, async t => {
  const { service, lifecycle } = await fixture(t), internal = service as any
  internal.saved.get('local').settings.workerSeats = 4
  const active = internal.running.get('local'), original = { ...lifecycle }
  active.connection.registration.workerSeats = 4; active.runtime.workerSeats = 4
  const updates: number[] = [], update = active.connection.updateWorkerSeats.bind(active.connection)
  active.connection.updateWorkerSeats = async (seats: number) => { updates.push(seats); return update(seats) }
  const changed = edit === 'worker-seats' ? { workerSeats: 1 } : { userName: 'Renamed display user', showCornerCharacter: false, swapPageIllustrations: true }
  const result = await service.configure({ mode: 'local', commandId: 'hot-' + edit, expectedRevision: 'local-settings', settings: { ...settings, workerSeats: 4, ...changed } })
  assert.equal(lifecycle.disposes, original.disposes, 'preferences/capacity updates must not kill in-flight native roles')
  assert.equal(lifecycle.closes, original.closes, 'same storage registration remains owned')
  assert.equal(lifecycle.opens, original.opens, 'same scope does not create a replacement backend')
  assert.equal(internal.running.get('local'), active)
  assert.deepEqual(updates, [edit === 'worker-seats' ? 1 : 4])
  assert.equal(active.runtime.workerSeats, edit === 'worker-seats' ? 1 : 4)
  assert.equal(result.connection.workerSeats, edit === 'worker-seats' ? 1 : 4)
  assert.equal(result.settings.workerSeats, edit === 'worker-seats' ? 1 : 4)
  if (edit === 'display-preferences') assert.equal(result.settings.userName, 'Renamed display user')
})

for (const failure of ['registration-readback', 'resource-readback'] as const) test(`hot seat update ${failure} failure remains unconfirmed and same-command retry preserves ownership`, async t => {
  const { service, lifecycle, storage } = await fixture(t), internal = service as any, active = internal.running.get('local')
  internal.saved.get('local').settings.workerSeats = 4
  active.connection.registration.workerSeats = 4; active.runtime.workerSeats = 4
  const original = { ...lifecycle }, update = active.connection.updateWorkerSeats.bind(active.connection), members = active.connection.members.bind(active.connection)
  let failing = true, attempts = 0
  active.connection.updateWorkerSeats = async (seats: number) => {
    attempts++
    if (failing && failure === 'registration-readback') throw new Error('Registration readback unavailable')
    return update(seats)
  }
  active.connection.members = async () => {
    if (failing && failure === 'resource-readback') throw new Error('Resource readback unavailable')
    return members()
  }
  const command = { mode: 'local' as const, commandId: 'hot-failure-' + failure, expectedRevision: 'local-settings', settings: { ...settings, workerSeats: 1 } }
  await assert.rejects(service.configure(command), /readback unavailable/)
  const failedView = await service.view({ mode: 'local' })
  assert.equal(failedView.settings.workerSeats, 1, 'saved requested setting is distinct from confirmed registration')
  assert.equal(failedView.connection.workerSeats, failure === 'registration-readback' ? 4 : 1)
  assert.equal(active.runtime.workerSeats, failure === 'registration-readback' ? 4 : 1)
  assert.match(failedView.connection.detail ?? '', /readback unavailable/)
  const commands = await storage.list<{ confirmed?: boolean }>('framework-settings-commands/')
  assert.equal(commands.length, 1)
  assert.notEqual(commands[0]!.value.confirmed, true)
  assert.deepEqual(lifecycle, original)
  failing = false
  const result = await service.configure(command)
  assert.equal(attempts, 2)
  assert.equal(result.connection.workerSeats, 1); assert.equal(active.runtime.workerSeats, 1)
  assert.equal(result.connection.detail, undefined)
  assert.equal(internal.running.get('local'), active)
  assert.deepEqual(lifecycle, original)
  assert.equal((await storage.list<{ confirmed?: boolean }>('framework-settings-commands/'))[0]!.value.confirmed, true)
  await service.configure(command)
  assert.equal(attempts, 2, 'confirmed replay does not reapply capacity or recreate roles')
})

import { FrameworkRoleRuntime } from '../src/framework/role-runtime.js'
test('service disposal owns a connection whose runtime start is still pending and never publishes it late', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dss-service-opening-'))
  const values = new Map<string, unknown>()
  const storage: StoragePort = { get: async key => structuredClone(values.get(key)) as never,
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    list: async prefix => [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) as never }
  const chosen = { ...settings, localDirectory: join(root, 'records'), workspace: root }
  const service = new FrameworkService({ workspaceRegistry: { create: async (directory: string) => ({ id: 'local-test-workspace', path: directory }) } } as any, storage, chosen)
  const internal = service as any
  internal.saved.set('local', { revision: 'loaded', settings: chosen })
  let enter!: () => void, release!: () => void, runtime: FrameworkRoleRuntime | undefined, disposals = 0
  const entered = new Promise<void>(resolve => { enter = resolve }), blocked = new Promise<void>(resolve => { release = resolve })
  // Only the native runtime startup boundary is delayed. Service.open, Local
  // connection registration/readback, migration and resource ownership are real.
  t.mock.method(FrameworkRoleRuntime.prototype, 'start', async function (this: FrameworkRoleRuntime) { runtime = this; enter(); await blocked })
  const actualDispose = FrameworkRoleRuntime.prototype.dispose
  t.mock.method(FrameworkRoleRuntime.prototype, 'dispose', async function (this: FrameworkRoleRuntime) { disposals++; await actualDispose.call(this) })
  const opening = internal.connect('local').then(() => ({ successful: true }), (error: unknown) => ({ successful: false, error }))
  try {
    await entered
    let closed = false
    const disposal = service.dispose().then(() => { closed = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(closed, false, 'dispose must retain ownership until the admitted opening settles')
    release()
    const outcome = await opening
    await disposal
    assert.equal(outcome.successful, false, 'late startup cannot publish a connected resource after disposal began')
    assert.equal(internal.running.size, 0)
    assert.equal(internal.opening.size, 0)
    assert.equal(disposals, 1)
    assert.ok(runtime)
    await assert.rejects(runtime.files.snapshot(), /closed/i)
    await assert.rejects(internal.connect('local'), /closed|disposed/i)
    await service.dispose()
    assert.equal(disposals, 1, 'disposal is idempotent')
  } finally { release(); await opening; await service.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('service disposal drains an admitted configuration and does not confirm settings whose participation was closed', async t => {
  const { service, storage } = await fixture(t), internal = service as any
  const active = internal.running.get('local')
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), blocked = new Promise<void>(resolve => { release = resolve })
  active.connection.updateWorkerSeats = async (seats: number) => { enter(); await blocked; return { ...active.connection.registration, workerSeats: seats } }
  const command = { mode: 'local' as const, commandId: 'configuration-during-close', expectedRevision: 'local-settings', settings: { ...settings, workerSeats: 4 } }
  const configuring = service.configure(command).then(() => ({ successful: true }), (error: unknown) => ({ successful: false, error }))
  await entered
  let closed = false
  const disposal = service.dispose().then(() => { closed = true })
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(closed, false)
    release()
    assert.equal((await configuring).successful, false)
    await disposal
    assert.equal(internal.running.size, 0)
    const stored = await storage.get<any>('framework-settings/local')
    assert.equal(stored.settings.workerSeats, 4, 'already saved settings remain the actual requested values; no invented rollback')
    const receipt = await storage.get<any>('framework-settings-commands/' + createHash('sha256').update(command.commandId).digest('hex'))
    assert.equal(receipt.confirmed, undefined, 'closed participation cannot become a confirmed successful configuration')
  } finally { release(); await configuring; await disposal }
})

test('disposed service rejects public reads and participation rather than reopening frontend or backend resources', async t => {
  const { service, lifecycle } = await fixture(t)
  await service.dispose()
  const after = { ...lifecycle }
  await assert.rejects(service.view({ mode: 'local' }), /disposed/)
  await assert.rejects(service.readFile({ mode: 'local', path: 'archives/T/records.md' }), /disposed/)
  await assert.rejects(service.history({ mode: 'local', collaborationId: 'team', limit: 10 }), /disposed/)
  await assert.rejects(service.send(input('local', 'after-close')), /disposed/)
  await assert.rejects(service.participation({ mode: 'local', enabled: true }), /disposed/)
  await assert.rejects(service.configure({ mode: 'local', commandId: 'closed-settings', settings }), /disposed/)
  assert.deepEqual(lifecycle, after)
})

test('service disposal still closes connections when runtime disposal fails and reports the failure', async t => {
  const { service, lifecycle } = await fixture(t), internal = service as any
  const failure = new Error('Native disposal did not confirm its owned producer')
  internal.running.get('local').runtime.dispose = async () => { throw failure }
  await assert.rejects(service.dispose(), (error: unknown) => error instanceof AggregateError && error.errors.includes(failure))
  assert.ok(lifecycle.closes >= 2, 'both owned connections are attempted despite the first runtime failure')
  assert.equal(internal.running.size, 0)
  await assert.rejects(service.dispose(), (error: unknown) => error instanceof AggregateError && error.errors.includes(failure))
})

test('late frontend storage acquisition is closed during service disposal without starting a backend', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dss-service-access-')), values = new Map<string, unknown>()
  const storage: StoragePort = { get: async key => structuredClone(values.get(key)) as never,
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    list: async prefix => [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) as never }
  const chosen = { ...settings, localDirectory: root }
  const service = new FrameworkService({} as any, storage, chosen), internal = service as any
  internal.saved.set('local', { revision: 'loaded', settings: chosen })
  let enter!: () => void, release!: () => void, acquired: LocalFiles | undefined
  const entered = new Promise<void>(resolve => { enter = resolve }), blocked = new Promise<void>(resolve => { release = resolve })
  const actualOpen = LocalFiles.open.bind(LocalFiles)
  t.mock.method(LocalFiles, 'open', async (directory: string) => { acquired = await actualOpen(directory); enter(); await blocked; return acquired })
  const access = internal.access('local').then(() => ({ successful: true }), (error: unknown) => ({ successful: false, error }))
  try {
    await entered
    let closed = false
    const disposal = service.dispose().then(() => { closed = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(closed, false)
    release()
    assert.equal((await access).successful, false)
    await disposal
    assert.ok(acquired)
    await assert.rejects(acquired.snapshot(), /closed/)
    assert.equal(internal.running.size, 0)
    assert.equal(internal.accesses.size, 0)
    assert.deepEqual(await storage.list('framework-instance/'), [], 'frontend acquisition never starts backend registration')
  } finally { release(); await access; await service.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('service disposal cancels its admitted background opener before awaiting acquisition', async t => {
  const {service}=await fixture(t), internal=service as any, entered=Promise.withResolvers<void>()
  internal.running.clear()
  let cancelled=0
  internal.open=async (_mode:unknown,signal:AbortSignal)=>{assert.ok(signal);entered.resolve();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>{cancelled++;reject(signal.reason)},{once:true}))}
  const opening=internal.connect('git').then(()=>false,(error:Error)=>error.name==='AbortError')
  await entered.promise;await service.dispose()
  assert.equal(await opening,true);assert.equal(cancelled,1)
  assert.equal(internal.running.size,0)
})

test('service closes active request owners before waiting for a hot settings operation blocked on that request', async t => {
  const {service}=await fixture(t),internal=service as any,active=internal.running.get('git'),entered=Promise.withResolvers<void>()
  const request=Promise.withResolvers<never>();let stopped=0
  active.connection.updateWorkerSeats=async()=>{entered.resolve();return request.promise}
  active.runtime.dispose=async()=>{stopped++;request.reject(new DOMException('owned request cancelled','AbortError'))}
  const operation=service.configure({mode:'git',commandId:'hot-while-close',expectedRevision:'git-settings',settings:{...settings,workerSeats:2}}).then(()=>false,()=>true)
  await entered.promise;await service.dispose()
  assert.equal(await operation,true);assert.equal(stopped,1)
})

test('explicit background withdrawal cancels an in-flight registration before waiting for its settings operation', async t => {
  const { service, storage } = await fixture(t), internal = service as any
  internal.running.delete('git')
  const entered = Promise.withResolvers<void>()
  let cancellations = 0
  internal.open = async (_mode: unknown, signal: AbortSignal) => {
    entered.resolve()
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { cancellations++; reject(signal.reason) }, { once: true }))
  }
  const frontend = internal.accesses.get('git')
  const configuring = service.configure({ mode: 'git', commandId: 'withdraw-registering', expectedRevision: 'git-settings', settings }).then(() => false, () => true)
  await entered.promise
  // A separately acquired pure storage handle while background registration is pending.
  internal.accesses.set('git', frontend)
  const withdrawing = service.participation({ mode: 'git', enabled: false })
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(cancellations, 1, 'withdrawal must reach the owned opener before waiting behind it')
    assert.equal(await configuring, true)
    await withdrawing
    assert.equal(await storage.get('framework-participation/git'), false)
    assert.equal(internal.running.has('git'), false)
    assert.equal(internal.running.has('local'), true, 'the other mode retains its execution owner')
    assert.equal((await service.history({ mode: 'git', collaborationId: 'team', limit: 10 })).messages.length, 0, 'withdrawal does not cancel pure frontend storage access')
  } finally {
    internal.backgroundOpening.get('git')?.abort()
    await configuring
    await withdrawing
  }
})

test('changing settings cancels the old frontend acquisition before awaiting its closure', async t => {
  const { service } = await fixture(t), internal = service as any
  internal.running.delete('git')
  const controller = new AbortController(), prior = internal.accesses.get('git')
  const pending = new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))
  internal.accessOpening.set('git', controller)
  internal.accesses.set('git', pending)
  const configuring = service.configure({ mode: 'git', commandId: 'replace-pending-access', expectedRevision: 'git-settings', settings: { ...settings, repositoryDirectory: 'new-root' } })
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(controller.signal.aborted, true, 'old storage acquisition must be cancelled before its close is awaited')
    await configuring
    assert.equal(internal.running.has('local'), true)
  } finally {
    controller.abort()
    await configuring
    await prior
  }
})

test('queued save is withdrawn before it can open, while a later explicit save remains valid', async t => {
  const { service, storage, lifecycle } = await fixture(t), internal = service as any
  internal.running.delete('git')
  const gate = Promise.withResolvers<void>()
  internal.configuration = gate.promise
  const old = service.configure({ mode: 'git', commandId: 'queued-before-withdrawal', expectedRevision: 'git-settings', settings }).then(() => false, () => true)
  const withdrawal = service.participation({ mode: 'git', enabled: false })
  gate.resolve()
  assert.equal(await old, true)
  await withdrawal
  assert.equal(lifecycle.opens, 0)
  assert.equal(await storage.get('framework-participation/git'), false)
  assert.equal(await storage.get('framework-settings/git'), undefined, 'withdrawn queued save did not publish its settings')
  await service.configure({ mode: 'git', commandId: 'new-after-withdrawal', expectedRevision: 'git-settings', settings })
  assert.equal(lifecycle.opens, 1)
  assert.equal(await storage.get('framework-participation/git'), true)
})

test('withdrawal interrupts a hot background update without cancelling frontend or the other mode', async t => {
  const { service, storage } = await fixture(t), internal = service as any, active = internal.running.get('git')
  const entered = Promise.withResolvers<void>(), blocked = Promise.withResolvers<never>()
  let cancellations = 0, frontendCancellations = 0
  ;(await internal.accesses.get('git')).connection.cancelPending = () => { frontendCancellations++ }
  active.connection.updateWorkerSeats = async () => { entered.resolve(); return blocked.promise }
  active.connection.cancelPending = (reason: unknown) => { cancellations++; blocked.reject(reason) }
  const configuring = service.configure({ mode: 'git', commandId: 'hot-withdrawal', expectedRevision: 'git-settings', settings: { ...settings, workerSeats: 3 } }).then(() => false, () => true)
  await entered.promise
  await service.participation({ mode: 'git', enabled: false })
  assert.equal(await configuring, true)
  assert.equal(cancellations, 1)
  assert.equal(frontendCancellations, 0)
  assert.equal(internal.running.has('local'), true)
  assert.equal(await storage.get('framework-participation/git'), false)
})

test('invalid, stale and identical replayed settings do not cancel a valid admitted save', async t => {
  const { service } = await fixture(t), internal = service as any
  internal.running.delete('git')
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), open = internal.open
  let signal: AbortSignal | undefined
  internal.open = async (mode: string, current: AbortSignal) => { signal = current; entered.resolve(); await release.promise; return open(mode) }
  const command = { mode: 'git' as const, commandId: 'stable-admission', expectedRevision: 'git-settings', settings }
  const first = service.configure(command)
  await entered.promise
  const same = service.configure(command)
  const invalid = service.configure({ ...command, commandId: 'invalid-admission', settings: { ...settings, workerSeats: -1 } }).then(() => false, () => true)
  const stale = service.configure({ ...command, commandId: 'stale-admission', expectedRevision: 'not-current' }).then(() => false, () => true)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(signal?.aborted, false)
  release.resolve()
  await first; await same
  assert.equal(await invalid, true); assert.equal(await stale, true)
})

test('saved participation intent survives a failed initial connection without claiming readback confirmation', async t => {
  const { service, storage } = await fixture(t), internal = service as any
  internal.running.delete('git')
  internal.open = async () => { throw new Error('Registration outcome unknown') }
  await assert.rejects(service.configure({ mode: 'git', commandId: 'initial-unknown', expectedRevision: 'git-settings', settings }), /outcome unknown/)
  assert.equal(await storage.get('framework-participation/git'), true)
  assert.equal(internal.running.has('git'), false)
  const receipt = await storage.get<any>('framework-settings-commands/' + createHash('sha256').update('initial-unknown').digest('hex'))
  assert.equal(receipt.confirmed, undefined)
  await storage.set('framework-settings/local', { revision: 'local-saved', settings })
  await storage.set('framework-participation/local', false)
  const restarted = new FrameworkService({} as any, storage, settings), attempted: string[] = []
  ;(restarted as any).open = async (mode: string) => { attempted.push(mode); throw new Error('Retained unknown publication still needs reconciliation') }
  await restarted.start()
  assert.deepEqual(attempted, ['git'], 'actual startup selects the persisted requested participation, not a fake connected flag')
  await restarted.dispose()
})

test('withdrawal owns a real Local connection whose native runtime startup has not returned', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dss-withdraw-start-')), values = new Map<string, unknown>()
  const storage: StoragePort = { get: async key => structuredClone(values.get(key)) as never,
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    list: async prefix => [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) as never }
  const chosen = { ...settings, localDirectory: root }
  const service = new FrameworkService({ workspaceRegistry: { create: async (directory: string) => ({ id: 'withdraw-test-workspace', path: directory }) } } as any, storage, chosen)
  const internal = service as any
  internal.saved.set('local', { revision: 'loaded', settings: chosen })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let runtime: FrameworkRoleRuntime | undefined
  t.mock.method(FrameworkRoleRuntime.prototype, 'start', async function (this: FrameworkRoleRuntime) { runtime = this; entered.resolve(); await release.promise })
  const opening = internal.connect('local').then(() => false, () => true)
  try {
    await entered.promise
    const withdrawing = service.participation({ mode: 'local', enabled: false })
    release.resolve()
    assert.equal(await opening, true, 'withdrawn startup cannot publish a late running resource')
    await withdrawing
    assert.equal(internal.running.size, 0)
    assert.equal(await storage.get('framework-participation/local'), false)
    await assert.rejects(runtime!.files.snapshot(), /closed/)
  } finally { release.resolve(); await opening; await service.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('queued participation enable is withdrawn without poisoning a later explicit enable', async t => {
  const { service, lifecycle, storage } = await fixture(t), internal = service as any
  internal.running.delete('git')
  const gate = Promise.withResolvers<void>(); internal.configuration = gate.promise
  const enable = service.participation({ mode: 'git', enabled: true }).then(() => false, () => true)
  const disable = service.participation({ mode: 'git', enabled: false })
  gate.resolve()
  assert.equal(await enable, true); await disable
  assert.equal(lifecycle.opens, 0)
  assert.equal(await storage.get('framework-participation/git'), false)
  await service.participation({ mode: 'git', enabled: true })
  assert.equal(lifecycle.opens, 1)
})

for (const phase of ['queued', 'opening'] as const) test(`a validated new configuration supersedes only the earlier ${phase} owner`, async t => {
  const { service, lifecycle } = await fixture(t), internal = service as any
  internal.running.delete('git')
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), open = internal.open
  let calls = 0
  if (phase === 'queued') internal.configuration = gate.promise
  else internal.open = async (mode: string, signal: AbortSignal) => {
    if (++calls === 1) { entered.resolve(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }
    return open(mode)
  }
  const old = service.configure({ mode: 'git', commandId: 'superseded-' + phase, expectedRevision: 'git-settings', settings }).then(() => false, () => true)
  if (phase === 'opening') await entered.promise
  const latest = service.configure({ mode: 'git', commandId: 'superseding-' + phase, expectedRevision: internal.saved.get('git').revision, settings: { ...settings, repositoryDirectory: 'next-root' } })
  gate.resolve()
  assert.equal(await old, true)
  await latest
  assert.equal(internal.saved.get('git').settings.repositoryDirectory, 'next-root')
  assert.equal(lifecycle.opens, 1)
  assert.equal(internal.running.has('local'), true)
})

test('a new configuration cannot adopt a startup opening captured for the previous storage scope', async t => {
  const { service } = await fixture(t), internal = service as any
  internal.running.delete('git')
  const entered = Promise.withResolvers<void>(), open = internal.open
  const scopes: string[] = []; let oldSignal: AbortSignal | undefined
  internal.open = async (mode: string, signal: AbortSignal) => {
    scopes.push(internal.saved.get(mode).settings.repositoryDirectory)
    if (scopes.length === 1) {
      oldSignal = signal; entered.resolve()
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
    return open(mode)
  }
  const startup = internal.connect('git').then(() => false, () => true)
  await entered.promise
  const changing = service.configure({ mode: 'git', commandId: 'replace-startup-scope', expectedRevision: 'git-settings', settings: { ...settings, repositoryDirectory: 'scope-B' } }).then(() => true, () => false)
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(oldSignal?.aborted, true, 'old unowned-by-config startup must be cancelled rather than adopted as scope B')
    assert.equal(await startup, true)
    assert.equal(await changing, true)
    assert.deepEqual(scopes, ['', 'scope-B'])
  } finally { internal.backgroundOpening.get('git')?.abort(); await startup; await changing }
})

for (const outcome of ['owned-abort', 'unknown', 'unowned-abort'] as const) test(`configuration diagnostics distinguish ${outcome} from a successful withdrawal`, async t => {
  const { service } = await fixture(t), internal = service as any, active = internal.running.get('git')
  const entered = Promise.withResolvers<void>(), blocked = Promise.withResolvers<never>()
  active.connection.updateWorkerSeats = async () => { entered.resolve(); return blocked.promise }
  active.connection.cancelPending = (reason: unknown) => blocked.reject(outcome === 'unknown' ? new FilesOutcomeUnknownError('retained-op') : reason)
  const configuring = service.configure({ mode: 'git', commandId: 'diagnostic-' + outcome, expectedRevision: 'git-settings', settings: { ...settings, workerSeats: 3 } }).then(() => false, () => true)
  await entered.promise
  if (outcome === 'unowned-abort') blocked.reject(new DOMException('Not cancelled by this caller', 'AbortError'))
  else await service.participation({ mode: 'git', enabled: false })
  assert.equal(await configuring, true, 'no cancellation or unknown outcome is reported as successful configuration')
  assert.equal(internal.configurationErrors.has('git'), outcome !== 'owned-abort')
  assert.equal(internal.errors.has('git'), outcome !== 'owned-abort')
})

test('replacing Local startup closes its late old connection and preserves old files before confirming the new scope', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dss-replace-start-')), storage = new Map<string, unknown>()
  const port: StoragePort = { get: async key => structuredClone(storage.get(key)) as never, set: async (key, value) => { storage.set(key, structuredClone(value)) },
    list: async prefix => [...storage].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) as never }
  const chosen = { ...settings, localDirectory: join(root, 'A') }, next = { ...chosen, localDirectory: join(root, 'B') }
  const service = new FrameworkService({ workspaceRegistry: { create: async (path: string) => ({ id: 'workspace', path }) } } as any, port, chosen), internal = service as any
  internal.saved.set('local', { revision: 'loaded', settings: chosen })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let old: FrameworkRoleRuntime | undefined, starts = 0
  t.mock.method(FrameworkRoleRuntime.prototype, 'start', async function (this: FrameworkRoleRuntime) {
    if (++starts === 1) {
      old = this
      await withSnapshot(this.files, snapshot => this.files.commit(snapshot, [{ path: 'retained.txt', content: 'Old scope original' }], 'QA original'))
      entered.resolve(); await release.promise
    }
  })
  const startup = internal.connect('local').then(() => false, () => true)
  try {
    await entered.promise
    const changing = service.configure({ mode: 'local', commandId: 'replace-native-startup', expectedRevision: 'loaded', settings: next })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(starts, 1, 'new scope waits for the cancelled old startup to settle')
    release.resolve()
    assert.equal(await startup, true)
    await changing
    assert.equal(starts, 2)
    assert.equal(internal.running.get('local').connection.files.directory, next.localDirectory)
    await assert.rejects(old!.files.snapshot(), /closed/)
    const retained = await LocalFiles.open(chosen.localDirectory)
    try { await withSnapshot(retained, async snapshot => assert.equal(await retained.read(snapshot, 'retained.txt'), 'Old scope original')) }
    finally { await retained.close() }
  } finally { release.resolve(); await startup; await service.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('unowned AbortError already rejected before withdrawal remains diagnostic', async t => {
  const { service } = await fixture(t), internal = service as any, active = internal.running.get('git')
  const entered = Promise.withResolvers<void>(), blocked = Promise.withResolvers<never>()
  active.connection.updateWorkerSeats = async () => { entered.resolve(); return blocked.promise }
  active.connection.cancelPending = () => {} // cannot have caused the already rejected operation
  const configuring = service.configure({ mode: 'git', commandId: 'unowned-before-owned', expectedRevision: 'git-settings', settings: { ...settings, workerSeats: 3 } }).then(() => false, () => true)
  await entered.promise
  const unrelated = new DOMException('Independent upstream AbortError before withdrawal', 'AbortError')
  blocked.reject(unrelated)
  const withdrawing = service.participation({ mode: 'git', enabled: false })
  assert.equal(await configuring, true)
  await withdrawing
  console.log('UNOWNED_ABORT_DIAGNOSTIC', JSON.stringify({ configurationError: internal.configurationErrors.get('git') ?? null, error: internal.errors.get('git') ?? null }))
  assert.equal(internal.configurationErrors.get('git'), unrelated.message)
})

test('superseded startup UNKNOWN remains visible after new scope successful opening', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dss-audit-startup-unknown-')), values = new Map<string, unknown>()
  const port: StoragePort = { get: async key => structuredClone(values.get(key)) as never,
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    list: async prefix => [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) as never }
  const chosen = { ...settings, localDirectory: join(root, 'A') }, next = { ...chosen, localDirectory: join(root, 'B') }
  values.set('framework-settings/local', { revision: 'loaded', settings: chosen })
  values.set('framework-settings/git', { revision: 'git-loaded', settings: chosen })
  values.set('framework-participation/local', true); values.set('framework-participation/git', false)
  const service = new FrameworkService({ workspaceRegistry: { create: async (path: string) => ({ id: 'workspace', path }) } } as any, port, chosen), internal = service as any
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let starts = 0
  const seenErrors: string[] = []
  service.subscribeChanged(() => { const value = internal.errors.get('local'); if (value) seenErrors.push(value) })
  t.mock.method(FrameworkRoleRuntime.prototype, 'start', async function () {
    if (++starts === 1) { entered.resolve(); await release.promise; throw new FilesOutcomeUnknownError('retained-old-scope-operation') }
  })
  const startup = service.start()
  let changing: Promise<unknown> | undefined
  try {
    await entered.promise
    changing = service.configure({ mode: 'local', commandId: 'unknown-startup-replaced', expectedRevision: 'loaded', settings: next })
    await new Promise<void>(resolve => setImmediate(resolve))
    release.resolve()
    await startup; await changing
    assert.equal(starts, 2)
    assert.ok(seenErrors.some(x => x.includes('uncertain')), 'old UNKNOWN was actually reported')
    console.log('STARTUP_UNKNOWN_DIAGNOSTIC', JSON.stringify({ seenErrors, finalError: internal.errors.get('local') ?? null, activeDirectory: internal.running.get('local').connection.files.directory }))
    assert.match(internal.errors.get('local') ?? '', /uncertain/)
  } finally { release.resolve(); await startup.catch(()=>{}); await changing?.catch(()=>{}); await service.dispose(); await rm(root, {recursive:true,force:true}) }
})


test('frontend read admitted during scope replacement cannot remain bound to old scope', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dss-audit-access-race-')), values = new Map<string, unknown>()
  const port: StoragePort = { get: async key => structuredClone(values.get(key)) as never,
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    list: async prefix => [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) as never }
  const chosen = { ...settings, localDirectory: join(root, 'A') }, next = { ...chosen, localDirectory: join(root, 'B') }
  const service = new FrameworkService({ workspaceRegistry: { create: async (path: string) => ({ id: 'workspace', path }) } } as any, port, chosen), internal = service as any
  internal.saved.set('local', { revision: 'loaded', settings: chosen })
  t.mock.method(FrameworkRoleRuntime.prototype, 'start', async function () {})
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let changing: Promise<any> | undefined
  try {
    await internal.connect('local')
    const before = await service.view({mode:'local'})
    await service.send({mode:'local', collaborationId:before.collaborationId, storageScope:before.storageScope!, id:'old-original-A', createdAt:'2026-11-01T03:00:00.000Z', text:'Original old scope A', recipient:'human', device:'audit'})
    const oldAccess = await internal.accesses.get('local'), close = oldAccess.connection.close.bind(oldAccess.connection)
    oldAccess.connection.close = async () => { entered.resolve(); await release.promise; await close() }
    changing = service.configure({ mode: 'local', commandId: 'replace-during-view', expectedRevision: 'loaded', settings: next })
    await entered.promise
    const duringRead = service.view({mode:'local'})
    await new Promise<void>(resolve => setImmediate(resolve))
    release.resolve()
    const during = await duringRead
    const after = await changing
    const finalAccess = await internal.accesses.get('local')
    console.log('FRONTEND_SCOPE_REPLACEMENT', JSON.stringify({ requested: after.settings.localDirectory, background: internal.running.get('local').connection.files.directory,
      during: during.settings.localDirectory, frontend: finalAccess.connection.files.directory, returnedScope: after.storageScope }))
    const message = { mode: 'local' as const, collaborationId: after.collaborationId, storageScope: after.storageScope, id: 'new-input-after-configure', createdAt: '2026-11-01T04:00:00.000Z', text: 'Expected new scope B', recipient: 'human' as const, device: 'audit' }
    assert.equal(after.storageScope, internal.running.get('local').connection.scope)
    assert.equal(during.storageScope, after.storageScope)
    assert.equal(during.settings.localDirectory, next.localDirectory)
    await assert.rejects(service.send({ ...message, id: 'old-A-scope', storageScope: oldAccess.connection.scope }), /Storage destination changed/)
    await service.send(message)
    const priorFiles = await LocalFiles.open(chosen.localDirectory)
    let writtenA: string[]
    try { const priorConversation = new FrameworkConversation(priorFiles, new FrameworkTransactions(priorFiles, port, 'old-A'), {mode:'local',collaborationId:chosen.collaborationId}); writtenA = (await priorConversation.page(20)).messages.map(row => row.text) } finally { await priorFiles.close() }
    const writtenB = (await internal.running.get('local').runtime.conversation.page(20)).messages.map((row: any) => row.text)
    console.log('SEND_AFTER_REPLACEMENT', JSON.stringify({ returnedScopeMatchesNewAccess: after.storageScope === finalAccess.connection.scope, writtenA, writtenB, oldAIdentityRejected: true }))
    assert.equal(finalAccess.connection.files.directory, next.localDirectory)
    assert.deepEqual(writtenA, ['Original old scope A'])
    assert.deepEqual(writtenB, ['Expected new scope B'])
  } finally { release.resolve(); await changing?.catch(()=>{}); await service.dispose(); await rm(root, {recursive:true,force:true}) }
})

test('successful hot settings do not clear an unrelated running-role diagnostic', async t => {
  const { service } = await fixture(t), internal = service as any
  internal.report('git', new Error('Independent Worker failure still needs diagnosis'))
  await service.configure({ mode: 'git', commandId: 'hot-not-role-repair', expectedRevision: 'git-settings', settings: { ...settings, workerSeats: 3 } })
  assert.match(internal.errors.get('git'), /Independent Worker failure/)
})

test('service shutdown preserves a real unknown publication instead of replacing it with a closed-settings diagnostic', async t => {
  const { service } = await fixture(t), internal = service as any
  const unknown = new FilesOutcomeUnknownError('unresolved-shutdown-write')
  internal.running.get('git').runtime.dispose = async () => { throw unknown }
  await assert.rejects(service.dispose(), (error: unknown) => error instanceof AggregateError && error.errors.includes(unknown))
  assert.match(internal.errors.get('git'), /unresolved-shutdown-write/)
  assert.match(internal.errors.get('git'), /Owner\/repo/)
})

test('only successful replay of the associated settings command clears its retained unknown operation', async t => {
  const { service } = await fixture(t), internal = service as any, active = internal.running.get('git')
  const actual = active.connection.updateWorkerSeats.bind(active.connection), unknown = new FilesOutcomeUnknownError('same-pending-op')
  let fail = true
  active.connection.updateWorkerSeats = async (seats: number) => { if (fail) { internal.report('git', unknown); throw unknown } return actual(seats) }
  const command = { mode: 'git' as const, commandId: 'resolve-pending-settings', expectedRevision: 'git-settings', settings: { ...settings, workerSeats: 3 } }
  await assert.rejects(service.configure(command), error => error === unknown)
  assert.match(internal.errors.get('git'), /same-pending-op/)
  fail = false
  await service.configure(command)
  assert.equal(internal.errors.has('git'), false)
})

test('confirmed Local cleanup is accessible without enabling participation and never clears the other mode', async t => {
  const { service, local, gitSeam, lifecycle } = await fixture(t), internal = service as any
  internal.running.delete('local')
  await service.send({ ...input('local', 'clear-me'), recipient: 'human' })
  await service.send({ ...input('git', 'keep-git'), recipient: 'human' })
  const access = await internal.access('local'), root = access.conversation.foregroundRoot
  await access.connection.transactions.run('seed-memory', {}, { reevaluate: true }, async () => [
    { path: root + '/Foreground_List.md', content: 'keep list' }, { path: root + '/Foreground_Cache.md', content: 'keep cache' },
  ])
  const before = { ...lifecycle }
  await assert.rejects(service.cleanupRecords({ mode: 'local', storageScope: 'wrong', commandId: 'wrong-scope', action: 'conversation', confirmation: 'clear-foreground-conversation' }), /scope|destination/i)
  const cleared = await service.cleanupRecords({ mode: 'local', storageScope: 'local', commandId: 'clear-chat', action: 'conversation', confirmation: 'clear-foreground-conversation' })
  assert.equal(cleared.cleared, true)
  assert.deepEqual((await service.history({ mode: 'local', collaborationId: 'team', storageScope: 'local', limit: 20 })).messages, [])
  assert.equal((await service.history({ mode: 'git', collaborationId: 'team', storageScope: 'git', limit: 20 })).messages.length, 1)
  assert.equal(await withSnapshot(local, snapshot => local.read(snapshot, root + '/Foreground_List.md')), 'keep list')
  assert.deepEqual(lifecycle, before)
  assert.equal(internal.running.has('local'), false)
  await service.send({ ...input('local', 'after-clear'), recipient: 'human' })
  await service.cleanupRecords({ mode: 'local', storageScope: 'local', commandId: 'clear-chat', action: 'conversation', confirmation: 'clear-foreground-conversation' })
  assert.deepEqual((await service.history({ mode: 'local', collaborationId: 'team', limit: 20 })).messages.map(message => message.id), ['after-clear'])
  await service.cleanupRecords({ mode: 'local', storageScope: 'local', commandId: 'clear-list', action: 'planning', confirmation: 'clear-work-planning-notes' })
  assert.equal(await withSnapshot(local, snapshot => local.read(snapshot, root + '/Foreground_List.md')), '')
  assert.equal((await service.history({ mode: 'local', collaborationId: 'team', limit: 20 })).messages.length, 1)
})

test('task history clear removes the user-visible record but keeps delivered attachment discovery and original bytes', async t => {
  const { service, local } = await fixture(t), internal = service as any
  internal.running.delete('local')
  const taskId = '00000000-0000-4000-8000-000000000078', archive = `archives/${taskId}`, artifact = archive + '/result.bin'
  const bytes = Uint8Array.from([0, 250, 4, 0, 255])
  await withSnapshot(local, snapshot => local.commit(snapshot, [
    { path: paths.task(taskId), content: JSON.stringify({ version: 1, taskId, route: 'P', owner: 'User', status: 'complete', sourcePath: 'tasks/kept_P.md', resultPaths: [artifact] }) },
    { path: archive + '/records.md', content: 'Actual retained record to clear' },
    { path: artifact, bytes },
    { path: `technical/cleanup/${taskId}.json`, content: JSON.stringify({ version: 1, taskId, phase: 'released', retentionHash: 'verified-fixture', deletedPaths: [], preservedPaths: [artifact] }) },
  ], 'synthetic released Task'))
  const preview = await service.cleanupPreview({ mode: 'local', storageScope: 'local' })
  assert.deepEqual(preview.tasks.map(item => item.taskId), [taskId])
  await service.cleanupRecords({ mode: 'local', storageScope: 'local', commandId: 'clear-task-record', action: 'tasks', preview, confirmation: 'clear-ended-task-records' })
  const view = await service.view({ mode: 'local', includeArchives: true })
  assert.equal(view.tasks.some(task => task.taskId === taskId), false)
  assert.equal(await withSnapshot(local, snapshot => local.read(snapshot, archive + '/records.md')), undefined)
  assert.deepEqual(view.archives.find(item => item.taskId === taskId)?.files, [artifact])
  assert.deepEqual(await service.download('local', artifact, 'local'), bytes)
  assert.ok(await withSnapshot(local, snapshot => local.read(snapshot, paths.task(taskId))))
})

test('Local maintenance uses explicit statistics, the actual native path opener and original record export', async t => {
  const { service, local } = await fixture(t), internal = service as any
  const workspace = await mkdtemp(join(tmpdir(), 'dss-export-workspace-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const { DshWorkspaceAdapter } = await import('../src/adapters/dsh/workspace.js')
  t.mock.method(DshWorkspaceAdapter.prototype, 'resolve', async () => ({ id: 'actual-fixture-workspace', directory: workspace } as any))
  const opened: string[] = []
  internal.ctx.get = (name: string) => {
    assert.equal(name, 'sessionController')
    return { canOpenWorkspacePath: () => true, openWorkspacePath: async ({ path }: { path: string }) => { opened.push(path) } }
  }
  internal.storage.storageView = () => ({ directory: '/actual-technical-records', nativeDirectory: '/actual-native-session-logs' })
  const original = '# Exact retained records\n\nUnicode 原文 😀\n'
  await withSnapshot(local, snapshot => local.commit(snapshot, [
    { path: 'archives/export-task/records.md', content: original },
    { path: 'assistants/collaborations/local/team/Foreground_Cache.md', content: 'cache-body' },
  ], 'synthetic retained records'))
  const usage = await service.maintenanceView({ mode: 'local', storageScope: 'local' })
  assert.equal(usage.localDirectory, local.directory)
  assert.equal(usage.nativeDirectory, '/actual-native-session-logs')
  assert.equal(usage.usage.permanent.planningBytes, Buffer.byteLength('cache-body'))
  await service.openMaintenancePath({ mode: 'local', storageScope: 'local', target: 'records' })
  await service.openMaintenancePath({ mode: 'local', storageScope: 'local', target: 'native-logs' })
  assert.deepEqual(opened, [local.directory, '/actual-native-session-logs'])
  const exported = await service.exportRecords({ mode: 'local', storageScope: 'local', taskId: 'export-task' })
  const { readFile } = await import('node:fs/promises')
  assert.equal(await readFile(exported.path, 'utf8'), original)
  assert.equal(await withSnapshot(local, snapshot => local.read(snapshot, 'archives/export-task/records.md')), original)
  assert.deepEqual(await service.exportRecords({ mode: 'local', storageScope: 'local', taskId: 'export-task' }), exported)
})

test('Local cancel, settled execution, manual clear and cold ownership retain artifacts without reopening Task', async t => {
  const { service, local, storage } = await fixture(t), internal=service as any;
  const {FrameworkRoleRuntime}=await import('../src/framework/role-runtime.js');
  const taskId='00000000-0000-4000-8000-000000000079', artifact=`archives/${taskId}/result.bin`;
  const ctx={agents:{get:()=>undefined},jobs:{list:()=>[]},get:()=>undefined} as any;
  const config={scope:'local',member:'User',primary:true,workspace:'/fixture',workerSeats:1,mode:'local' as const,collaborationId:'team'};
  const runtime=new FrameworkRoleRuntime(ctx,local,storage,config,{members:()=>['User'],heartbeat:async()=>{},error:()=>{}}) as any;
  internal.running.get('local').runtime=runtime; internal.running.get('local').connection.registration.member='User';
  await withSnapshot(local,snapshot=>local.commit(snapshot,[
    {path:paths.task(taskId),content:JSON.stringify({version:1,taskId,route:'P',owner:'User',members:['User'],status:'running',sourcePath:'tasks/cancel_P.md',resultPaths:[artifact]})},
    {path:'tasks/cancel_P.md',content:taskId+'\nOriginal cancelled request'},
    {path:paths.inbox(taskId,'User'),content:'unfinished material'},
    {path:`archives/${taskId}/records.md`,content:'retained partial history'},
    {path:artifact,bytes:Uint8Array.from([0,255,8])},
  ],'synthetic active responsibility'));
  const record={identity:{role:'Worker',workId:'cancel-worker',executionId:'cancel-execution',taskId},sessionId:'cancel-session',generation:1};
  await runtime.saveRole(record);
  let stops=0;
  // Native stopping is an explicit boundary fixture; storage, controls,
  // cancellation ownership, cleanup transaction and cold runtime are real.
  runtime.stopOwnedRecord=async (actual:any)=>{assert.equal(actual.identity.executionId,'cancel-execution');stops++;return {status:'stopped'}};
  await service.taskControl({mode:'local',storageScope:'local',commandId:'explicit-cancel',taskId,intent:'cancelled'});
  assert.equal(stops,1);
  const preview=await service.cleanupPreview({mode:'local',storageScope:'local'});
  assert.ok(preview.tasks.some(task=>task.taskId===taskId));
  const request={mode:'local' as const,storageScope:'local',commandId:'clear-cancelled',action:'tasks' as const,preview,confirmation:'clear-ended-task-records' as const};
  const commit=local.commit.bind(local);
  let entered!:()=>void, release!:()=>void;
  const atCommit=new Promise<void>(resolve=>{entered=resolve}), released=new Promise<void>(resolve=>{release=resolve});
  local.commit=async (snapshot,changes,message)=>{
    if(changes.some(change=>change.path===`technical/cleanup/${taskId}.json` && 'content' in change && change.content?.includes('historyCleared'))) {entered();await released;}
    return commit(snapshot,changes,message);
  };
  const clearing=service.cleanupRecords(request);
  await atCommit;
  const resuming=service.taskControl({mode:'local',storageScope:'local',commandId:'racing-resume',taskId,intent:'running'});
  const resumeResult=assert.rejects(resuming,/explicitly cleared/);
  assert.equal((await runtime.controls.task(taskId)).intent,'cancelled','queued resume cannot cross the confirmed deletion owner');
  release(); await clearing; await resumeResult; local.commit=commit;
  assert.equal(await runtime.controls.task(taskId),undefined);
  assert.equal((await service.view({mode:'local',includeArchives:true})).tasks.some(task=>task.taskId===taskId),false);
  assert.deepEqual(await service.download('local',artifact,'local'),Uint8Array.from([0,255,8]));
  await assert.rejects(service.taskControl({mode:'local',storageScope:'local',commandId:'late-resume',taskId,intent:'running'}),/explicitly cleared/);
  await service.cleanupRecords(request); assert.equal(stops,1);
  const cold=new FrameworkRoleRuntime(ctx,local,storage,config,{members:()=>['User'],heartbeat:async()=>{},error:()=>{}}) as any;
  assert.deepEqual(await withSnapshot(local,snapshot=>cold.scanMembers(snapshot)),[]);
  await assert.rejects(cold.resumeTask(taskId,'cold-resume'),/explicitly cleared/);
  await withSnapshot(local,async snapshot=>assert.equal(JSON.parse((await local.read(snapshot,paths.task(taskId)))!).status,'running'));
});

test('migrated report attachments are discoverable without a new records.md, while external references remain text only', async t => {
  const old = await legacyFixture('Preserve the original report attachments'), planner = await old.bind('plan')
  assert.equal((await old.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 0, strategy: 'Save original output', children: [childSpec()] }, planner.source)).status, 'applied')
  const worker = await old.bind('dispatch'), bytes = Uint8Array.from([0, 255, 4, 128]), sha256 = createHash('sha256').update(bytes).digest('hex')
  const artifacts = [{ id: 'inside', path: 'original.bin', description: 'Original bytes', sha256 }, { id: 'outside', path: '/outside/declared-but-not-authorized.bin', description: 'Original external reference', sha256 }]
  assert.equal((await old.execute({ type: 'execution.report', report: { resultId: 'original-result', assignmentVersion: 1, outcome: 'complete', summary: 'Original report', artifacts, evidence: ['Existing saved files'], frontier: 'Awaiting review' } }, worker.source)).status, 'applied')
  const { service, local, storage } = await fixture(t), capture = await captureLocalLegacy(old.storage)
  // This test owns view/read/download, not filesystem authorization. The native
  // capture adapter's separate real-filesystem tests supply this byte boundary.
  const plan = await withSnapshot(local, snapshot => prepareLegacyMigration(capture, local, snapshot, { id: 'artifact-view', owner: 'User-1', members: { assistant: 'User-1' }, artifacts: [{ taskId: 'one', sourcePath: 'original.bin', bytes }] }))
  await applyLegacyMigration(local, new FrameworkTransactions(local, storage, 'artifact-view'), plan)
  const page = await service.view({ mode: 'local', includeArchives: true }), task = page.legacyTasks.find(row => row.oldTaskId === 'one')!
  assert.ok(task)
  assert.equal(await withSnapshot(local, snapshot => local.read(snapshot, `archives/${task.taskId}/records.md`)), undefined)
  const inside = task.artifacts?.find(row => row.id === 'inside'), outside = task.artifacts?.find(row => row.id === 'outside')
  assert.equal(inside?.status, 'archived'); assert.ok(inside?.archivedPath)
  assert.equal((await service.readFile({ mode: 'local', storageScope: 'local', path: inside.archivedPath })).binary?.sha256, sha256)
  assert.deepEqual(await service.download('local', inside.archivedPath, 'local'), bytes)
  assert.equal(outside?.status, 'pending'); assert.equal(outside?.sourcePath, artifacts[1]!.path); assert.equal(outside?.sha256, sha256); assert.equal(outside?.archivedPath, undefined)
  const originalRead = local.read.bind(local); let sourceReads = 0
  local.read = async (snapshot, path) => { if (path.includes('/source/')) sourceReads++; return originalRead(snapshot, path) }
  const ordinary = await service.view({ mode: 'local' })
  assert.deepEqual(ordinary.legacyTasks.find(row => row.oldTaskId === 'one')?.artifacts, task.artifacts)
  assert.equal(sourceReads, 0, 'ordinary view does not rescan the legacy source bodies')
})

for (const alreadyMigrated of [false, true, 'offline', 'slow', 'closing', 'send', 'fresh-slow'] as const) test(`actual service opening imports declared legacy bytes (${alreadyMigrated === 'fresh-slow' ? 'first cutover with held file' : typeof alreadyMigrated === 'string' ? 'verified cutover without participation: ' + alreadyMigrated : alreadyMigrated ? 'verified old cutover' : 'first cutover'})`, async t => {
  const fs = await import('node:fs/promises'), path = await import('node:path')
  const root = await fs.mkdtemp(join(tmpdir(), 'dss-artifact-service-open-')), workspace = join(root, 'workspace'), directory = join(root, 'records')
  await fs.mkdir(workspace)
  const bytes = Uint8Array.from([0, 255, ...Buffer.from('original legacy result 😀')]), digest = createHash('sha256').update(bytes).digest('hex')
  await fs.writeFile(join(workspace, 'result.bin'), bytes)
  await fs.writeFile(join(root, 'outside.bin'), bytes)
  const { readBaselineSource } = await import('./legacy-baseline.js')
  const source = readBaselineSource('tests/task-fixture.ts').replace('fixture(request?: string)', 'fixture(workspace: string)').replace('if (request) input.goal.request = request', 'input.workspace.directory = workspace')
  const { fixture: oldFixture } = await loadBaselineModule<{ fixture(workspace: string): Promise<Awaited<ReturnType<typeof legacyFixture>>> }>('tests/task-fixture.ts', source)
  const old = await oldFixture(workspace), planner = await old.bind('plan')
  await old.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 0, strategy: 'Store result', children: [childSpec()] }, planner.source)
  const worker = await old.bind('dispatch')
  assert.equal((await old.execute({ type: 'execution.report', report: { resultId: 'native-file', assignmentVersion: 1, outcome: 'complete', summary: 'Original output', artifacts: [{ id: 'output', path: 'result.bin', description: 'Declared result', sha256: digest }, { id: 'external-output', path: join(root, 'outside.bin'), description: 'External original reference', sha256: digest }], evidence: ['Original file exists'], frontier: 'Ready' } }, worker.source)).status, 'applied')
  for (const execution of Object.values((await old.get()).executions)) await old.execute({ type: 'execution.observed', executionId: execution.executionId, physicalState: 'stopped', ownedJobIds: [] })
  if (alreadyMigrated && alreadyMigrated !== 'fresh-slow') {
    const { migrateFrameworkStorage } = await import('../src/framework/migration-lifecycle.js'), files = await LocalFiles.open(directory)
    const scope = JSON.stringify(['local', await fs.realpath(directory)])
    try { await migrateFrameworkStorage({ mode: 'local', scope, files, transactions: new FrameworkTransactions(files, old.storage, scope), records: old.storage,
      options: (_capture, id) => ({ id, owner: 'User', members: { assistant: 'User' } }) }) } finally { await files.close() }
  }
  let contentReads = 0; const readPaths: string[] = []
  let entered!: () => void, release!: () => void
  const atRead = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const slow = alreadyMigrated === 'slow' || alreadyMigrated === 'closing' || alreadyMigrated === 'send' || alreadyMigrated === 'fresh-slow'

  const ctx = { workspaceRegistry: { create: async (value: string) => ({ id: 'artifact-workspace', path: value }) }, agents: { get: () => undefined }, jobs: { list: () => [] }, fs: {
    resolve: async (value: string, options?: { cwd?: string }) => ({ path: await fs.realpath(path.resolve(options?.cwd ?? workspace, value)) }),
    contains: (parent: { path: string }, child: { path: string }) => { const r = path.relative(parent.path, child.path); return r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r) },
    stat: async (value: { path: string }) => { const s = await fs.stat(value.path, { bigint: true }); return { type: s.isFile() ? 'file' : 'directory', size: Number(s.size), version: [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':') } },
    readByteRange: async (value: { path: string }, range: { offset: number; length: number }) => { contentReads++; readPaths.push(value.path); if (slow) { entered(); await held; } const handle = await fs.open(value.path, 'r'); try { const buffer = Buffer.alloc(range.length), result = await handle.read(buffer, 0, range.length, range.offset); return buffer.subarray(0, result.bytesRead) } finally { await handle.close() } },
  } }
  const chosen = { ...settings, workspace, localDirectory: directory }, service = new FrameworkService(ctx as any, old.storage, chosen), internal = service as any
  internal.saved.set('local', { revision: 'loaded', settings: chosen })
  // Only native model scheduling is suppressed. Service.open, original capture,
  // Local registration, cutover/reconciliation and FilesStore are actual classes.
  t.mock.method(FrameworkRoleRuntime.prototype, 'start', async () => {})
  try {
    if (alreadyMigrated === 'fresh-slow') {
      let ready = false
      const opening = internal.connect('local').then(() => { ready = true; return service.view({ mode: 'local' }) })
      await atRead
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(ready, true, 'original-file bytes are not a prerequisite for the authoritative first metadata cutover')
      await opening
    } else if (typeof alreadyMigrated === 'string') {
      await old.storage.set('framework-settings/local', { revision: 'loaded-local', settings: chosen }); await old.storage.set('framework-settings/git', { revision: 'loaded-git', settings: chosen });
      await old.storage.set('framework-participation/local', false); await old.storage.set('framework-participation/git', false);
      await service.start(); assert.equal(internal.running.size, 0, 'attachment repair does not enable background participation')
    } else await internal.connect('local')
    if (slow) {
      await atRead
      const readable = await service.view({ mode: 'local' })
      assert.ok(readable.legacyTasks.some(row => row.oldTaskId === 'one'), 'verified old records remain readable during held original-file IO')
      await service.history({ mode: 'local', collaborationId: chosen.collaborationId, storageScope: readable.storageScope, limit: 20 })
      if (alreadyMigrated === 'send') {
        await service.send({ mode: 'local', collaborationId: chosen.collaborationId, storageScope: readable.storageScope, id: 'during-original-file-read', createdAt: '2026-11-01T08:30:00.000Z', text: 'New input remains writable', recipient: 'human', device: 'owned-repair-test' })
        release()
        await (await internal.access('local')).artifactRepair?.done
        const history = await service.history({ mode: 'local', collaborationId: chosen.collaborationId, storageScope: readable.storageScope, limit: 20 })
        assert.ok(JSON.stringify(history).includes('New input remains writable'))
        assert.equal(internal.running.size, 0)
        return
      }
      if (alreadyMigrated === 'closing') {
        let settled = false
        const closing = service.dispose().then(() => { settled = true })
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(settled, false, 'dispose owns the actual in-flight repair until it settles')
        release(); await closing
        assert.equal(internal.accesses.size, 0)
        return
      }
      release()
    }
    await (await internal.access('local')).artifactRepair?.done
    const ordinaryAfterRepair = await service.view({ mode: 'local' })
    assert.equal(ordinaryAfterRepair.legacyTasks.find(row => row.oldTaskId === 'one')?.artifacts?.find(row => row.id === 'output')?.status, 'archived', 'completion notification retains the ready reference without requiring another Archives click')
    const page = await service.view({ mode: 'local', includeArchives: true }), imported = page.legacyTasks.find(row => row.oldTaskId === 'one')?.artifacts?.find(row => row.id === 'output')
    assert.equal(imported?.status, 'archived'); assert.ok(imported?.archivedPath)
    assert.deepEqual(await service.download('local', imported.archivedPath, page.storageScope), bytes)
    assert.ok(contentReads > 0, 'production service actually called the filesystem capability, not supplied MigrationOptions bytes')
    assert.deepEqual([...new Set(readPaths)], [join(workspace, 'result.bin')], 'outside reference never grants content-read authority')
    assert.match(page.connection.detail ?? '', /outside|workspace/i, 'successful runtime startup must not erase an unresolved migration issue')
    assert.equal(page.legacyTasks.find(row => row.oldTaskId === 'one')?.artifacts?.find(row => row.id === 'external-output')?.archivedPath, undefined)
    assert.deepEqual(new Uint8Array(await fs.readFile(join(workspace, 'result.bin'))), bytes)
    const count = contentReads; await service.view({ mode: 'local' }); assert.equal(contentReads, count)
  } finally { release(); await service.dispose(); await fs.rm(root, { recursive: true, force: true }) }
})

test('optional processing read failure preserves actual saved conversation in service view', async t => {
  const {service}=await fixture(t), internal=service as any
  await service.send(input('local','retained'))
  const active=internal.running.get('local'); active.connection.scope='local'
  active.runtime.foregroundProcessing=async()=>{throw new Error('ACK read unavailable')}
  const result=await service.view({mode:'local'})
  assert.equal(result.messages[0].id,'retained')
  assert.equal(result.foregroundProcessing,undefined)
  assert.match(result.connection.detail!,/ACK read unavailable/)
})
