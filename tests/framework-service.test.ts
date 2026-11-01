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
    const connection = { files, transactions, scope: mode, identity: { login: mode === 'local' ? 'User' : 'Owner', owner: 'Owner', instanceUUID: '00000000-0000-4000-8000-000000000002', repositoryId: mode }, prepareWrite: async () => {}, repository: mode === 'git' ? { identity: { login: 'Owner', id: 42 } } : undefined, close: async () => {} }
    const conversation = new FrameworkConversation(files, transactions, { mode, collaborationId: internal.saved.get(mode).settings.collaborationId })
    internal.accesses.set(mode, Promise.resolve({ connection, conversation }))
    const registration = { member: mode === 'local' ? 'User-1' : 'Owner-2', workerSeats: internal.saved.get(mode).settings.workerSeats }
    return { connection: { files, registration, updateWorkerSeats: async (seats: number) => { registration.workerSeats = seats; return registration }, members: async () => [{ member: 'Offline-1', availability: 'offline', instanceUUID: 'old-instance', workerSeats: 2 }], repository: mode === 'git' ? { identity: { login: 'Owner', id: 42 } } : undefined, close: async () => { lifecycle.closes++ } },
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
  const resumes: string[] = []; let applied = 0
  runtime.applyUserControls = async () => { applied++ }
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
  assert.deepEqual(resumes, ['T']); assert.equal(applied, 3)
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
  assert.deepEqual(first.messages.map(message => message.id), ['early']); assert.equal(first.moreAfter, 'early')
  const second = await service.history({ ...query, afterId: first.moreAfter })
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
