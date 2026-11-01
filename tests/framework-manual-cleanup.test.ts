import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFiles } from '../src/framework/local-files.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
import { FrameworkConversation } from '../src/framework/conversation.js'
import { FrameworkManualCleanup, type ManualCleanupLifecycle } from '../src/framework/manual-cleanup.js'
import { cleanupRecordPath } from '../src/framework/cleaner.js'
import { paths, type TaskMetadata } from '../src/framework/task-files.js'
import { FilesConflictError, FilesOutcomeUnknownError, withSnapshot, type FileChange } from '../src/framework/transactions.js'
import type { StoragePort } from '../src/contracts/ports.js'
import { createHash } from 'node:crypto'
import { captureLocalLegacy, prepareLegacyMigration, applyLegacyMigration, type LegacyCapture } from '../src/framework/legacy-migration.js'
import { BaselineConversationStore, loadBaselineModule, readBaselineSource } from './legacy-baseline.js'
import { listLegacyRecordExports, readLegacyRecordExport } from '../src/framework/legacy-record-export.js'
import { FrameworkArtifacts } from '../src/framework/artifacts.js'
import type { Task } from '../src/contracts/task.js'
import { MemoryStorage } from './support.js'
const id = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dss-manual-cleanup-')), files = await LocalFiles.open(root)
  t.after(async () => { await files.close(); await rm(root, { recursive: true, force: true }) })
  const data = new Map<string, unknown>()
  const records: StoragePort = { async get<T>(key: string) { return structuredClone(data.get(key)) as T | undefined }, async set(key, value) { data.set(key, structuredClone(value)) }, async list<T>(prefix: string) { return [...data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as T })) } }
  const transactions = new FrameworkTransactions(files, records, 'manual-test')
  const conversation = new FrameworkConversation(files, transactions, { mode: 'local', collaborationId: 'team' })
  let resets = 0, releases = 0
  const lifecycle: ManualCleanupLifecycle = { async withForegroundReset(_id, action) { resets++; return action() }, async prepareTaskCleanup() { releases++ } }
  const cleanup = () => new FrameworkManualCleanup(files, transactions, conversation, lifecycle)
  const put = (changes: readonly FileChange[]) => withSnapshot(files, snapshot => files.commit(snapshot, changes, 'synthetic fixture'))
  const read = (path: string) => withSnapshot(files, snapshot => files.read(snapshot, path))
  const send = (messageId: string, text = messageId, target = conversation) => target.send('send-' + messageId, { id: messageId, participantId: 'synthetic-user', createdAt: '2026-10-31T00:00:00.000Z', role: 'user', text, recipient: 'ai' })
  const seedTask = async (taskId = id, status: TaskMetadata['status'] = 'complete', released = true) => {
    const task: TaskMetadata = { version: 1, taskId, route: 'P', owner: 'A', status, sourcePath: 'tasks/request-' + taskId + '_P.md', resultPaths: [paths.archive(taskId) + '/result.bin'] }
    await put([{ path: paths.task(taskId), content: JSON.stringify(task) }, { path: task.sourcePath, content: 'Task ID: ' + taskId + '\nOriginal request' },
      { path: paths.archive(taskId) + '/records.md', content: 'Long retained original history' }, { path: paths.archive(taskId) + '/retention.json', content: '{"outputs":[],"retainedPaths":[]}' },
      { path: paths.archive(taskId) + '/result.bin', bytes: Uint8Array.from([0, 255, 128]) },
      { path: paths.run(taskId) + '/A/Planner_Memory.md', content: 'Prior reasoning' },
      ...(released ? [{ path: cleanupRecordPath(taskId), content: JSON.stringify({ version: 1, taskId, phase: 'released', retentionHash: 'known', deletedPaths: [], preservedPaths: [] }) }] : []),
    ])
    return task
  }
  return { root, files, transactions, conversation, lifecycle, cleanup, put, read, send, seedTask, resets: () => resets, releases: () => releases }
}
test('Local manual task clear really removes only reviewed history and keeps bytes, knowledge, UUID and release facts', async t => {
  const f = await fixture(t), task = await f.seedTask()
  await f.seedTask(other, 'running', false)
  await f.put([{ path: 'skills/retained/SKILL.md', content: 'User skill' }, { path: 'knowledge/facts/known.json', content: 'Long knowledge' }, { path: 'state/Foreground_pending-task-result', content: '' }])
  await f.send('old-chat')
  const external = join(f.root, 'actual-user-result.txt'); await writeFile(external, 'External artifact stays')
  const cleanup = f.cleanup(), preview = await cleanup.previewTasks()
  assert.deepEqual(preview.tasks.map(task => task.taskId), [id])
  const result = await cleanup.clearTasks('clear-task', preview, 'clear-ended-task-records')
  assert.equal(result.cleared, true); assert.equal(f.releases(), 1)
  for (const path of [paths.archive(id) + '/records.md', paths.archive(id) + '/retention.json', paths.run(id) + '/A/Planner_Memory.md', task.sourcePath]) assert.equal(await f.read(path), undefined, path)
  for (const path of [paths.task(id), 'skills/retained/SKILL.md', 'knowledge/facts/known.json', 'state/Foreground_pending-task-result', paths.archive(other) + '/records.md']) assert.notEqual(await f.read(path), undefined, path)
  assert.equal((await f.conversation.read('old-chat'))?.text, 'old-chat')
  assert.deepEqual(await withSnapshot(f.files, snapshot => f.files.readBytes(snapshot, paths.archive(id) + '/result.bin')), Uint8Array.from([0, 255, 128]))
  assert.equal(await readFile(external, 'utf8'), 'External artifact stays')
  const release = JSON.parse((await f.read(cleanupRecordPath(id)))!)
  assert.equal(release.phase, 'released'); assert.equal(release.historyCleared, true)
  assert.deepEqual(release.preservedArtifacts, [paths.archive(id) + '/result.bin'])
  assert.deepEqual((await cleanup.previewTasks()).tasks, [])
})
test('preview does not include later ended tasks and changed reviewed content rejects without deletion', async t => {
  const f = await fixture(t); await f.seedTask()
  const cleanup = f.cleanup(), preview = await cleanup.previewTasks()
  await f.seedTask(other)
  await cleanup.clearTasks('first', preview, 'clear-ended-task-records')
  assert.notEqual(await f.read(paths.archive(other) + '/records.md'), undefined)
  const second = await cleanup.previewTasks()
  await f.put([{ path: paths.archive(other) + '/records.md', content: 'Late fact must survive' }])
  await assert.rejects(cleanup.clearTasks('second', second, 'clear-ended-task-records'), /preview changed/)
  assert.equal(await f.read(paths.archive(other) + '/records.md'), 'Late fact must survive')
})
test('completed but not released and running/paused tasks are not mistaken for settled historical records', async t => {
  const f = await fixture(t); await f.seedTask(id, 'complete', false); await f.seedTask(other, 'running', false)
  assert.deepEqual((await f.cleanup().previewTasks()).tasks, []); assert.equal(f.releases(), 0)
})
test('all destructive actions require their own literal confirmation; Git cannot invoke Local cleanup', async t => {
  const f = await fixture(t); await f.send('keep'); await f.seedTask()
  const cleanup = f.cleanup(), preview = await cleanup.previewTasks()
  await assert.rejects(cleanup.clearTasks('x', preview, 'wrong' as never), /explicit confirmation/)
  await assert.rejects(cleanup.clearConversation('x', 'wrong' as never), /explicit confirmation/)
  await assert.rejects(cleanup.clearPlanning('x', 'wrong' as never), /explicit confirmation/)
  const git = new FrameworkConversation(f.files, f.transactions, { mode: 'git', collaborationId: 'team' })
  await assert.rejects(new FrameworkManualCleanup(f.files, f.transactions, git, f.lifecycle).clearConversation('x', 'clear-foreground-conversation'), /Local/)
  assert.equal(f.resets(), 0); assert.equal((await f.conversation.page(10)).messages.length, 1)
})
test('conversation cleanup waits for exact Foreground retirement, preserves independent conversation/planning/background and replays without another reset', async t => {
  const f = await fixture(t); await f.send('old'); await f.seedTask(other, 'running', false)
  await f.conversation.writeForeground('memory', { list: 'Keep List', cache: 'Keep Cache' })
  const otherConversation = new FrameworkConversation(f.files, f.transactions, { mode: 'local', collaborationId: 'other' })
  await f.send('separate', 'Other conversation', otherConversation)
  let stopped = false
  f.lifecycle.withForegroundReset = async (_id, action) => { assert.equal((await f.conversation.page(10)).messages.length, 1); stopped = true; return action() }
  const cleanup = f.cleanup(); await cleanup.clearConversation('chat', 'clear-foreground-conversation')
  assert.equal(stopped, true); assert.deepEqual((await f.conversation.page(10)).messages, [])
  assert.equal((await otherConversation.read('separate'))?.text, 'Other conversation')
  assert.deepEqual(await f.conversation.readForeground(), { list: 'Keep List', cache: 'Keep Cache' })
  assert.notEqual(await f.read(paths.task(other)), undefined)
  f.lifecycle.withForegroundReset = async () => { throw new Error('Must not reset the newer session') }
  await f.send('new'); await cleanup.clearConversation('chat', 'clear-foreground-conversation')
  assert.equal((await f.conversation.read('new'))?.text, 'new')
})
test('unconfirmed native stop keeps all original conversation bytes', async t => {
  const f = await fixture(t); await f.send('old')
  f.lifecycle.withForegroundReset = async () => { throw new Error('native producer remains unconfirmed') }
  await assert.rejects(f.cleanup().clearConversation('chat', 'clear-foreground-conversation'), /unconfirmed/)
  assert.equal((await f.conversation.read('old'))?.text, 'old')
})
test('planning reset touches only List/Cache and a confirmed command cannot erase newer notes on replay', async t => {
  const f = await fixture(t); await f.send('old')
  await f.conversation.writeForeground('memory', { list: 'Old List', cache: 'Old Cache' })
  const cleanup = f.cleanup(); await cleanup.clearPlanning('notes', 'clear-work-planning-notes')
  assert.deepEqual(await f.conversation.readForeground(), { list: '', cache: '' })
  assert.equal((await f.conversation.read('old'))?.text, 'old'); assert.equal(f.resets(), 0)
  await f.conversation.writeForeground('new-memory', { list: 'New List', cache: 'New Cache' })
  await cleanup.clearPlanning('notes', 'clear-work-planning-notes')
  assert.deepEqual(await f.conversation.readForeground(), { list: 'New List', cache: 'New Cache' })
})
test('lost acknowledgement after real SQLite cleanup COMMIT replays the same scope without clearing newer conversation', async t => {
  const f = await fixture(t); await f.send('old')
  const commit = f.files.commit.bind(f.files); let lost = false
  f.files.commit = async (snapshot, changes, message) => {
    const receipt = await commit(snapshot, changes, message)
    if (!lost && changes.some(change => change.path === f.conversation.indexPath)) { lost = true; throw new FilesOutcomeUnknownError('actual-commit-ack-lost', undefined, receipt) }
    return receipt
  }
  await assert.rejects(f.cleanup().clearConversation('chat', 'clear-foreground-conversation'), FilesOutcomeUnknownError)
  await f.send('new')
  f.lifecycle.withForegroundReset = async () => { throw new Error('No new reset on committed replay') }
  await f.cleanup().clearConversation('chat', 'clear-foreground-conversation')
  assert.equal((await f.conversation.read('new'))?.text, 'new')
})
test('restart resumes a confirmed Foreground reset intent before deletion, never another collaboration', async t => {
  const f = await fixture(t); await f.send('old')
  f.lifecycle.withForegroundReset = async () => { throw new Error('controlled process exit before native reset confirmation') }
  await assert.rejects(f.cleanup().clearConversation('confirmed-command', 'clear-foreground-conversation'), /process exit/)
  const otherConversation = new FrameworkConversation(f.files, f.transactions, { mode: 'local', collaborationId: 'other' })
  const otherCleanup = new FrameworkManualCleanup(f.files, f.transactions, otherConversation, f.lifecycle)
  assert.deepEqual(await otherCleanup.resumePending(), [])
  assert.equal((await f.conversation.read('old'))?.text, 'old')
  f.lifecycle.withForegroundReset = async (id, action) => { assert.equal(id, 'confirmed-command'); return action() }
  assert.equal((await f.cleanup().resumePending()).length, 1)
  assert.equal(await f.conversation.read('old'), undefined)
  assert.deepEqual(await f.cleanup().resumePending(), [])
})
test('an interrupted fixed conversation plan removes its old selection without re-scanning later appends', async t => {
  const f = await fixture(t); await f.send('old')
  const commit = f.files.commit.bind(f.files); let interrupted = false
  f.files.commit = async (snapshot, changes, message) => {
    if (!interrupted && changes.some(change => change.path === f.conversation.indexPath)) { interrupted = true; throw new Error('controlled pre-dispatch process exit') }
    return commit(snapshot, changes, message)
  }
  await assert.rejects(f.cleanup().clearConversation('fixed', 'clear-foreground-conversation'), /process exit/)
  await f.send('new')
  await f.cleanup().resumePending()
  assert.deepEqual((await f.conversation.page(10)).messages.map(message => message.id), ['new'])
})
test('late task content or result identity after plan persistence cannot be hidden or removed', async t => {
  const f = await fixture(t); await f.seedTask()
  const cleanup = f.cleanup(), preview = await cleanup.previewTasks(), commit = f.files.commit.bind(f.files)
  let interrupted = false
  f.files.commit = async (snapshot, changes, message) => {
    if (!interrupted && changes.some(change => change.content === null)) { interrupted = true; throw new Error('controlled plan-to-apply interruption') }
    return commit(snapshot, changes, message)
  }
  await assert.rejects(cleanup.clearTasks('fixed-task', preview, 'clear-ended-task-records'), /interruption/)
  await f.put([{ path: paths.archive(id) + '/late-record.md', content: 'New durable evidence' }])
  await assert.rejects(f.cleanup().resumePending(), FilesConflictError)
  await assert.rejects(f.cleanup().resumePending(), /cleanup changed/)
  assert.equal(await f.read(paths.archive(id) + '/late-record.md'), 'New durable evidence')
  assert.notEqual(await f.read(paths.archive(id) + '/records.md'), undefined)
  assert.equal(JSON.parse((await f.read(cleanupRecordPath(id)))!).historyCleared, undefined)
})
test('archived actual artifact manifests preserve original binary bytes even absent from resultPaths', async t => {
  const f = await fixture(t); await f.seedTask()
  const path = paths.archive(id) + '/original.png', digest = (text: string) => createHash('sha256').update(text).digest('hex')
  await f.put([{ path, bytes: Uint8Array.from([137, 80, 78, 71, 0, 255]) },
    { path: 'technical/artifacts/manifests/' + digest(path) + '.json', content: JSON.stringify({ version: 1, taskId: id, path }) }])
  const cleanup = f.cleanup(), result = await cleanup.clearTasks('keep-image', await cleanup.previewTasks(), 'clear-ended-task-records')
  assert.ok(result.preservedPaths.includes(path))
  assert.deepEqual(await withSnapshot(f.files, snapshot => f.files.readBytes(snapshot, path)), Uint8Array.from([137, 80, 78, 71, 0, 255]))
})
test('reused submission names and forged conversation references cannot delete unrelated files', async t => {
  const f = await fixture(t), task = await f.seedTask()
  await f.put([{ path: task.sourcePath, content: 'A different future task without the prior UUID' }])
  const cleanup = f.cleanup(); await cleanup.clearTasks('old-task', await cleanup.previewTasks(), 'clear-ended-task-records')
  assert.equal(await f.read(task.sourcePath), 'A different future task without the prior UUID')
  await f.put([{ path: 'knowledge/private.json', content: '{"id":"message","collaborationId":"team","textPath":"knowledge/text"}' },
    { path: f.conversation.indexPath, content: JSON.stringify({ version: 1, messages: [{ id: 'message', path: 'knowledge/private.json' }] }) }])
  await assert.rejects(cleanup.clearConversation('forged', 'clear-foreground-conversation'), /exact owned message/)
  assert.notEqual(await f.read('knowledge/private.json'), undefined)
})
async function legacyFixture(f: Awaited<ReturnType<typeof fixture>>, shared = false) {
  const oldId = 'original-ended-task', key = 'records/' + oldId + '/manifest', ref = 'dss-record://' + encodeURIComponent('task-origin/' + oldId + '/2026/entry/request')
  const source: LegacyCapture = { mode: 'local', baseline: '0acd3ba39a2ae23d66759279b3c54c4637cd0ad5', revision: 'synthetic-old', issues: [],
    records: [{ key, bytes: Buffer.from(JSON.stringify({ text: 'Exact retained old record' })), ...(shared ? { reference: 'unknown-shared-reference' } : {}) },
      { key: 'knowledge/facts/keep', bytes: Buffer.from(JSON.stringify({ kind: 'not-validated-old-knowledge', text: 'Do not remove other data' })) }],
    texts: [{ ref, text: 'Exact original old request' }],
    tasks: [{ id: oldId, continuation: 'complete', request: 'Exact original old request', participants: [], original: { reports: {}, id: oldId } as never }] }
  // Omit unrelated invalid knowledge: preserve a separate real current skill instead.
  source.records = source.records.filter(record => !record.key.startsWith('knowledge/'))
  const plan = await withSnapshot(f.files, snapshot => prepareLegacyMigration(source, f.files, snapshot,
    { id: 'synthetic-migration', owner: 'A', members: {} }, f.transactions))
  await applyLegacyMigration(f.files, f.transactions, plan)
  return { plan, taskId: plan.manifest.tasks[0].taskId, raw: plan.manifest.records.find(record => record.key === key)!.path, text: plan.manifest.references[ref] }
}
test('actual migration planner maps ended legacy task records and copies for exact cleanup without erasing migration identity', async t => {
  const f = await fixture(t), legacy = await legacyFixture(f)
  const cleanup = f.cleanup(), preview = await cleanup.previewTasks()
  assert.deepEqual(preview.tasks.map(task => task.taskId), [legacy.taskId])
  await cleanup.clearTasks('legacy-history', preview, 'clear-ended-task-records')
  for (const path of [legacy.raw, legacy.text, legacy.plan.manifest.tasks[0].recordPath]) assert.equal(await f.read(path), undefined, path)
  const manifest = JSON.parse((await f.read(legacy.plan.manifestPath))!)
  assert.deepEqual(manifest.tasks, []); assert.equal(manifest.clearedTasks[0].taskId, legacy.taskId)
  assert.equal(manifest.source.revision, 'synthetic-old'); assert.notEqual(await f.read('technical/legacy-migrations/index.json'), undefined)
})
test('unknown shared migration aliases do not authorize deleting the shared source copy', async t => {
  const f = await fixture(t), legacy = await legacyFixture(f, true), cleanup = f.cleanup()
  await cleanup.clearTasks('legacy-shared', await cleanup.previewTasks(), 'clear-ended-task-records')
  assert.notEqual(await f.read(legacy.raw), undefined, 'unknown shared reference must retain its source body')
})
test('legacy terminal metadata cannot override a current running task with the same UUID', async t => {
  const f = await fixture(t), legacy = await legacyFixture(f)
  await f.seedTask(legacy.taskId, 'running', false)
  assert.deepEqual((await f.cleanup().previewTasks()).tasks, [])
})
test('real baseline conversation migration clears selected raw copies and keeps the other assistant mapping and source storage', async t => {
  const f = await fixture(t), source = new MemoryStorage(), old = new BaselineConversationStore(source)
  await old.append('old-one', 'session-one', { id: 'old-message', role: 'user', text: 'Original conversation before migration' })
  await old.append('old-two', 'session-two', { id: 'other-message', role: 'user', text: 'Other assistant conversation' })
  const before = JSON.stringify([...source.data]), capture = await captureLocalLegacy(source)
  const plan = await withSnapshot(f.files, snapshot => prepareLegacyMigration(capture, f.files, snapshot, { id: 'conversation-migration', owner: 'A', members: {}, conversations: [
    { scope: { mode: 'local', collaborationId: 'team' }, assistantId: 'old-one', participantId: 'one' },
    { scope: { mode: 'local', collaborationId: 'other' }, assistantId: 'old-two', participantId: 'two' },
  ] }, f.transactions))
  await applyLegacyMigration(f.files, f.transactions, plan)
  const owned = plan.manifest.records.filter(record => /^(conversations|conversation-index|conversation-staging|conversation-exchanges)\/old-one\//.test(record.key))
  assert.ok(owned.length)
  await f.cleanup().clearConversation('clear-imported-chat', 'clear-foreground-conversation')
  for (const record of owned) assert.equal(await f.read(record.path), undefined, record.key)
  assert.deepEqual((await f.conversation.page(10)).messages, [])
  const otherChat = new FrameworkConversation(f.files, f.transactions, { mode: 'local', collaborationId: 'other' })
  assert.equal((await otherChat.read('other-message'))?.text, 'Other assistant conversation')
  const after = JSON.parse((await f.read(plan.manifestPath))!)
  assert.deepEqual(after.messages.map((message: { collaborationId: string }) => message.collaborationId), ['other'])
  assert.equal(JSON.stringify([...source.data]), before, 'migration source is not this selected current store')
})
test('closing and reopening real SQLite preserves confirmed intent without relying on in-memory command acknowledgements', async t => {
  const f = await fixture(t); await f.send('old')
  f.lifecycle.withForegroundReset = async () => { throw new Error('stop pending at process exit') }
  await assert.rejects(f.cleanup().clearConversation('durable-intent', 'clear-foreground-conversation'), /process exit/)
  await f.files.close()
  const reopened = await LocalFiles.open(f.root); t.after(() => reopened.close())
  const records = new MemoryStorage(), transactions = new FrameworkTransactions(reopened, records, 'manual-test')
  const conversation = new FrameworkConversation(reopened, transactions, { mode: 'local', collaborationId: 'team' })
  const cleanup = new FrameworkManualCleanup(reopened, transactions, conversation, {
    async withForegroundReset(commandId, action) { assert.equal(commandId, 'durable-intent'); return action() }, async prepareTaskCleanup() {},
  })
  assert.equal((await cleanup.resumePending()).length, 1)
  assert.equal(await conversation.read('old'), undefined)
})
test('repeated concurrent invocation uses one authoritative deletion plan and receipt', async t => {
  const f = await fixture(t); await f.seedTask()
  const cleanup = f.cleanup(), preview = await cleanup.previewTasks()
  const results = await Promise.all([cleanup.clearTasks('same', preview, 'clear-ended-task-records'), cleanup.clearTasks('same', preview, 'clear-ended-task-records')])
  assert.ok(results.every(result => result.cleared)); assert.equal(f.releases(), 1)
  assert.equal(await f.read(paths.archive(id) + '/records.md'), undefined)
})
test('another live Task result reference preserves the exact shared artifact in the cleared archive', async t => {
  const f = await fixture(t); await f.seedTask(); const otherTask = await f.seedTask(other, 'running', false)
  const shared = paths.archive(id) + '/shared-output.txt'
  await f.put([{ path: shared, content: 'Delivered result used by another task' },
    { path: paths.task(other), content: JSON.stringify({ ...otherTask, resultPaths: [shared] }) }])
  const cleanup = f.cleanup(); await cleanup.clearTasks('shared-result', await cleanup.previewTasks(), 'clear-ended-task-records')
  assert.equal(await f.read(shared), 'Delivered result used by another task')
})
test('one failed confirmed intent reports its real failure and cannot block a later independent cleanup', async t => {
  const f = await fixture(t); await f.send('retained-chat'); await f.conversation.writeForeground('old-notes', { list: 'Old', cache: 'Old' })
  const key = (id: string) => createHash('sha256').update(JSON.stringify(f.conversation.scope) + '\0' + id).digest('hex')
  const [failed, later] = ['command-a', 'command-b'].sort((a, b) => key(a).localeCompare(key(b)))
  const failure = new Error('real producer stop not confirmed')
  f.lifecycle.withForegroundReset = async () => { throw failure }
  await assert.rejects(f.cleanup().clearConversation(failed, 'clear-foreground-conversation'), error => error === failure)
  const commit = f.files.commit.bind(f.files)
  f.files.commit = async (snapshot, changes, message) => {
    if (changes.some(change => change.path === f.conversation.foregroundRoot + '/Foreground_List.md')) throw new Error('controlled interruption before clearing notes')
    return commit(snapshot, changes, message)
  }
  await assert.rejects(f.cleanup().clearPlanning(later, 'clear-work-planning-notes'), /controlled interruption/)
  f.files.commit = commit
  const reported: Array<{ error: unknown; commandId: string }> = []
  const result = await f.cleanup().resumePending((error, commandId) => { reported.push({ error, commandId }) })
  assert.equal(result.length, 1); assert.deepEqual(reported, [{ error: failure, commandId: failed }])
  assert.deepEqual(await f.conversation.readForeground(), { list: '', cache: '' })
  assert.equal((await f.conversation.read('retained-chat'))?.text, 'retained-chat')
})
test('batch cleanup records only each Task own retained result references', async t => {
  const f = await fixture(t), first = await f.seedTask(), second = await f.seedTask(other)
  const a = paths.run(id) + '/own-result.txt', b = paths.run(other) + '/own-result.txt'
  await f.put([{ path: a, content: 'A result' }, { path: b, content: 'B result' },
    { path: paths.task(id), content: JSON.stringify({ ...first, resultPaths: [a] }) },
    { path: paths.task(other), content: JSON.stringify({ ...second, resultPaths: [b] }) }])
  const cleanup = f.cleanup(); await cleanup.clearTasks('batch', await cleanup.previewTasks(), 'clear-ended-task-records')
  assert.deepEqual(JSON.parse((await f.read(cleanupRecordPath(id)))!).preservedArtifacts, [a])
  assert.deepEqual(JSON.parse((await f.read(cleanupRecordPath(other)))!).preservedArtifacts, [b])
})
test('confirmation freezes old messages even when stop is unconfirmed and newer messages arrive before retry', async t => {
  const f = await fixture(t); await f.send('old-at-confirmation')
  f.lifecycle.withForegroundReset = async () => { throw new Error('exact old native stop is unconfirmed') }
  await assert.rejects(f.cleanup().clearConversation('frozen-confirmation', 'clear-foreground-conversation'), /unconfirmed/)
  await f.send('new-after-confirmation')
  f.lifecycle.withForegroundReset = async (_command, action) => action()
  await f.cleanup().clearConversation('frozen-confirmation', 'clear-foreground-conversation')
  assert.equal(await f.conversation.read('old-at-confirmation'), undefined)
  assert.equal((await f.conversation.read('new-after-confirmation'))?.text, 'new-after-confirmation')
})
test('unconfirmed cleanup without COMMIT later removes only the original selection while preserving new appended messages', async t => {
  const f = await fixture(t); await f.send('old-selected')
  const commit = f.files.commit.bind(f.files); let unknown = true
  f.files.commit = async (snapshot, changes, message) => {
    if (unknown && changes.some(change => change.path === f.conversation.indexPath)) { unknown = false; throw new FilesOutcomeUnknownError('unconfirmed-without-commit') }
    return commit(snapshot, changes, message)
  }
  await assert.rejects(f.cleanup().clearConversation('fixed-before-unknown', 'clear-foreground-conversation'), FilesOutcomeUnknownError)
  await f.send('new-while-unknown')
  await f.cleanup().clearConversation('fixed-before-unknown', 'clear-foreground-conversation')
  assert.equal(await f.conversation.read('old-selected'), undefined)
  assert.equal((await f.conversation.read('new-while-unknown'))?.text, 'new-while-unknown')
})
test('only confirmed old native capture IDs extend the frozen message selection, never later user or unrelated assistant messages', async t => {
  const f = await fixture(t); await f.send('old')
  f.lifecycle.withForegroundReset = async () => { throw new Error('stop unknown') }
  await assert.rejects(f.cleanup().clearConversation('clear-old-session', 'clear-foreground-conversation'), /stop unknown/)
  await f.send('new-human')
  await f.conversation.send('new-assistant-command', { id: 'unrelated-assistant', participantId: 'A', createdAt: '2026-11-01T00:00:00.000Z', role: 'assistant', text: 'A different current reply', recipient: 'human' })
  f.lifecycle.withForegroundReset = async (_id, action) => {
    await f.conversation.send('native-old-target', { id: 'captured-old-final', participantId: 'A', createdAt: '2026-11-01T00:00:00.001Z', role: 'assistant', text: 'Old target final captured during confirmed retirement', recipient: 'human', replyTo: 'old' })
    return action(['captured-old-final'])
  }
  await f.cleanup().clearConversation('clear-old-session', 'clear-foreground-conversation')
  assert.deepEqual((await f.conversation.page(10)).messages.map(message => message.id), ['new-human', 'unrelated-assistant'])
  assert.equal(await f.conversation.read('captured-old-final'), undefined)
})
test('a new message reusing an already consumed empty notification retains its signal after old history removal', async t => {
  const f = await fixture(t); await f.send('old')
  f.lifecycle.withForegroundReset = async () => { throw new Error('stop unknown') }
  await assert.rejects(f.cleanup().clearConversation('same-empty-signal', 'clear-foreground-conversation'), /stop unknown/)
  const pending = await f.conversation.pendingForeground()
  await f.conversation.claimForeground('consume-old', ['old'], { list: 'Keep', cache: 'Keep' }, { expectedRevision: pending.revision })
  await f.send('new') // Identical synthetic timestamp/participant now reuses the absent base signal.
  f.lifecycle.withForegroundReset = async (_id, action) => action()
  await f.cleanup().clearConversation('same-empty-signal', 'clear-foreground-conversation')
  assert.deepEqual((await f.conversation.pendingForeground()).messages.map(message => message.id), ['new'])
  assert.equal((await withSnapshot(f.files, snapshot => f.files.listDirectory(snapshot, 'state/'))).length, 1)
  assert.deepEqual(await f.conversation.readForeground(), { list: 'Keep', cache: 'Keep' })
})
test('native capture extension cannot turn a later human message into a cleanup target', async t => {
  const f = await fixture(t); await f.send('old')
  f.lifecycle.withForegroundReset = async () => { throw new Error('stop unknown') }
  await assert.rejects(f.cleanup().clearConversation('capture-owner', 'clear-foreground-conversation'), /stop unknown/)
  await f.send('new-human')
  f.lifecycle.withForegroundReset = async (_id, action) => action(['new-human'])
  await assert.rejects(f.cleanup().clearConversation('capture-owner', 'clear-foreground-conversation'), /exact owned message/)
  assert.deepEqual((await f.conversation.page(10)).messages.map(message => message.id), ['old', 'new-human'])
})
test('rebasing the conversation index does not relax original body version checks', async t => {
  const f = await fixture(t); await f.send('old')
  f.lifecycle.withForegroundReset = async () => { throw new Error('stop unknown') }
  await assert.rejects(f.cleanup().clearConversation('body-guard', 'clear-foreground-conversation'), /stop unknown/)
  const chunk = await withSnapshot(f.files, async snapshot => (await f.files.list(snapshot, 'conversations/local/')).find(entry => entry.path.endsWith('/parts/000000.txt'))!.path)
  await f.put([{ path: chunk, content: 'Changed body after confirmation' }]); await f.send('new')
  f.lifecycle.withForegroundReset = async (_id, action) => action()
  await assert.rejects(f.cleanup().clearConversation('body-guard', 'clear-foreground-conversation'), /cleanup target changed/)
  assert.equal(await f.read(chunk), 'Changed body after confirmation')
  assert.equal((await f.conversation.read('new'))?.text, 'new')
})


// Actual fixed old producers: completed commands -> journal -> sealed ordered
// records -> cleanup (live task root gone), not fabricated archived task JSON.
const oldRecordsSource = readBaselineSource('tests/completion-records.test.ts')
const oldRecordsProducer = await loadBaselineModule<{ produce(): Promise<{ storage: StoragePort; task: Task }> }>(
  'tests/completion-records.test.ts', oldRecordsSource.slice(0, oldRecordsSource.indexOf('\ntest(')) + `
export async function produce() {
 const f = await accepted(); await finish(f);
 await f.store.journal.append({scope:{kind:'planner-memory',taskId:'one'},commandId:'retained-long-history',text:'原封存长期记录🙂\\n'.repeat(5000),source:f.runtime});
 const task=await f.get();assert.equal(await f.tasks.cleanupCompleted('one'),true);
 return {storage:f.storage,task};
}`)
async function oldHistoryOnly(f: Awaited<ReturnType<typeof fixture>>, migrationId = 'previous-consumer') {
  const old = await oldRecordsProducer.produce(), capture = await captureLocalLegacy(old.storage)
  assert.equal(await old.storage.get('task:one'), undefined)
  assert.ok(await old.storage.get('task-history/one'))
  // Exactly the former capture omissions. The archive manifest, all original
  // chunks and journal text remain outputs from the real historical producer.
  capture.tasks = []
  capture.texts = capture.texts.filter(entry => entry.ref !== 'records/one/records.md')
  const plan = await withSnapshot(f.files, snapshot => prepareLegacyMigration(capture, f.files, snapshot,
    { id: migrationId, owner: 'A', members: {} }, f.transactions))
  await applyLegacyMigration(f.files, f.transactions, plan)
  assert.deepEqual(plan.manifest.tasks, [])
  const identities = await withSnapshot(f.files, snapshot => listLegacyRecordExports(f.files, snapshot, plan.manifestPath))
  assert.equal(identities.length, 1)
  return { old, plan, taskId: identities[0]!.taskId }
}
test('actual old history-only migration with no tasks rows is explicitly previewed and cleared without inventing a Task', async t => {
  const f = await fixture(t), legacy = await oldHistoryOnly(f)
  const before = JSON.stringify(await legacy.old.storage.list(''))
  const preview = await f.cleanup().previewTasks()
  assert.deepEqual(preview.tasks.map(task => task.taskId), [legacy.taskId])
  assert.ok(preview.fileCount > 0)
  const result = await f.cleanup().clearTasks('clear-history-only', preview, 'clear-ended-task-records')
  assert.equal(result.cleared, true); assert.equal(f.releases(), 1)
  const manifest = JSON.parse((await f.read(legacy.plan.manifestPath))!)
  assert.deepEqual(manifest.tasks, [], 'no scheduling metadata was backfilled')
  assert.deepEqual(manifest.clearedTasks.map((item: any) => ({ oldId: item.oldId, taskId: item.taskId })), [{ oldId: 'one', taskId: legacy.taskId }])
  assert.deepEqual(await withSnapshot(f.files, snapshot => listLegacyRecordExports(f.files, snapshot, legacy.plan.manifestPath)), [])
  await assert.rejects(withSnapshot(f.files, snapshot => readLegacyRecordExport(f.files, snapshot, { manifestPath: legacy.plan.manifestPath, oldTaskId: 'one' })), /cleared|unavailable/)
  assert.equal(await f.read(paths.task(legacy.taskId)), undefined); assert.equal(await f.read(cleanupRecordPath(legacy.taskId)), undefined)
  assert.equal(JSON.stringify(await legacy.old.storage.list('')), before, 'the original legacy source is never deleted')
  assert.deepEqual((await f.cleanup().previewTasks()).tasks, [])
})


test('history-only cleanup retains actual binary artifacts and their discoverable receipt, unknown shared aliases and other Task records', async t => {
  const f = await fixture(t), legacy = await oldHistoryOnly(f)
  const data = Uint8Array.from([0, 255, 128, 1, 13, 10]), output = paths.archive(legacy.taskId) + '/retained-output.bin'
  const source = { fs: { resolve: async () => ({ path: 'synthetic' }), stat: async () => ({ type: 'file', version: 'stable-synthetic', size: data.length }),
    readByteRange: async (_target: unknown, options: { offset: number; length: number }) => data.slice(options.offset, options.offset + options.length) } }
  const artifacts = new FrameworkArtifacts(source as never, f.files, f.transactions, 'synthetic-workspace')
  const artifact = await artifacts.preserve('actual-preserve-history-result', { taskId: legacy.taskId, sourcePath: 'synthetic-result.bin', destinationPath: output })
  const shared = legacy.plan.manifest.records.find(record => record.key.startsWith('records/one/content/'))!
  const manifest = structuredClone(legacy.plan.manifest)
  manifest.references['unknown-other-owner'] = shared.path; manifest.referenceHashes['unknown-other-owner'] = shared.sha256
  await f.put([{ path: legacy.plan.manifestPath, content: JSON.stringify(manifest) }, { path: 'skills/keep/SKILL.md', content: 'Retained skill' }, { path: 'knowledge/keep.json', content: 'Retained knowledge' }])
  await f.seedTask(other, 'running', false)
  const preview = await f.cleanup().previewTasks(), result = await f.cleanup().clearTasks('clear-legacy-keep-output', preview, 'clear-ended-task-records')
  assert.ok(result.preservedPaths.includes(output)); assert.deepEqual((await artifacts.read(output)).data, data)
  assert.notEqual(await f.read(artifact.manifestPath), undefined)
  const cleared = JSON.parse((await f.read(legacy.plan.manifestPath))!)
  assert.deepEqual(cleared.clearedTasks, [{ oldId: 'one', taskId: legacy.taskId, preservedArtifacts: [output] }])
  assert.equal(cleared.references['unknown-other-owner'], shared.path); assert.notEqual(await f.read(shared.path), undefined)
  for (const entry of ['skills/keep/SKILL.md', 'knowledge/keep.json', paths.task(other), paths.archive(other) + '/records.md']) assert.notEqual(await f.read(entry), undefined, entry)
  assert.equal(await f.read(cleanupRecordPath(legacy.taskId)), undefined, 'no forged Cleaner released fact')
})

test('new Task or new archive after history-only confirmation is not added to the fixed cleanup receipt, including COMMIT acknowledgement loss', async t => {
  const f = await fixture(t), first = await oldHistoryOnly(f, 'original-history')
  const preview = await f.cleanup().previewTasks(), commit = f.files.commit.bind(f.files)
  let lost = false
  f.files.commit = async (snapshot, changes, message) => {
    const result = await commit(snapshot, changes, message)
    if (!lost && changes.some(change => change.content === null)) { lost = true; throw new FilesOutcomeUnknownError('same-local-cleanup', { cause: new Error('lost acknowledgement') }, result) }
    return result
  }
  await assert.rejects(f.cleanup().clearTasks('stable-history-clear', preview, 'clear-ended-task-records'), FilesOutcomeUnknownError)
  const later = await oldHistoryOnly(f, 'later-history'); await f.seedTask(other, 'complete', true)
  const result = await f.cleanup().clearTasks('stable-history-clear', preview, 'clear-ended-task-records')
  assert.equal(result.receipt.replay, true); assert.equal(f.releases(), 1)
  assert.equal(JSON.parse((await f.read(first.plan.manifestPath))!).clearedTasks.length, 1)
  assert.equal(JSON.parse((await f.read(later.plan.manifestPath))!).clearedTasks, undefined)
  assert.equal((await withSnapshot(f.files, snapshot => listLegacyRecordExports(f.files, snapshot, later.plan.manifestPath))).length, 1)
  assert.notEqual(await f.read(paths.archive(other) + '/records.md'), undefined)
})

test('uncommitted UNKNOWN replays only original history identities after proven revision conflict, never a later migration', async t => {
  const f = await fixture(t), first = await oldHistoryOnly(f, 'first-uncommitted'), preview = await f.cleanup().previewTasks()
  const commit = f.files.commit.bind(f.files); let lost = false
  f.files.commit = async (snapshot, changes, message) => {
    if (!lost && changes.some(change => change.content === null)) { lost = true; throw new FilesOutcomeUnknownError('not-yet-committed') }
    return commit(snapshot, changes, message)
  }
  await assert.rejects(f.cleanup().clearTasks('fixed-before-commit', preview, 'clear-ended-task-records'), FilesOutcomeUnknownError)
  const later = await oldHistoryOnly(f, 'later-uncommitted')
  await assert.rejects(f.cleanup().clearTasks('fixed-before-commit', preview, 'clear-ended-task-records'), FilesConflictError)
  await f.cleanup().clearTasks('fixed-before-commit', preview, 'clear-ended-task-records')
  assert.equal(f.releases(), 1, 'original plan is reused, not rebuilt around the newer archive')
  assert.equal(JSON.parse((await f.read(first.plan.manifestPath))!).clearedTasks.length, 1)
  assert.equal(JSON.parse((await f.read(later.plan.manifestPath))!).clearedTasks, undefined)
})

test('history-only candidate requires complete sealed bytes and current same-ID Task always has priority', async t => {
  const f = await fixture(t), legacy = await oldHistoryOnly(f)
  await f.seedTask(legacy.taskId, 'running', false)
  assert.deepEqual((await f.cleanup().previewTasks()).tasks, [])
  await f.put([{ path: paths.task(legacy.taskId), content: null }])
  const sealed = await legacy.old.storage.get<any>('records/one/manifest'), key = sealed.document.find((segment: any) => segment.parts).parts[0].key
  const path = legacy.plan.manifest.references[key]!
  await f.put([{ path, content: 'Changed original bytes' }])
  await assert.rejects(f.cleanup().previewTasks(), /corrupt/)
  assert.notEqual(await f.read(legacy.plan.manifestPath), undefined)
})

test('old clearedTasks without artifact field remain cleared and cannot become a fresh cleanup candidate', async t => {
  const f = await fixture(t), legacy = await oldHistoryOnly(f)
  await f.put([{ path: legacy.plan.manifestPath, content: JSON.stringify({ ...legacy.plan.manifest, clearedTasks: [{ oldId: 'one', taskId: legacy.taskId }] }) }])
  assert.deepEqual((await f.cleanup().previewTasks()).tasks, [])
  const manifest = JSON.parse((await f.read(legacy.plan.manifestPath))!)
  assert.deepEqual(manifest.clearedTasks, [{ oldId: 'one', taskId: legacy.taskId }])
})

function cancellation(f: Awaited<ReturnType<typeof fixture>>, taskId = id) {
  const state = { intent: 'cancelled', settled: true, commandId: 'explicit-user-cancel', signature: 'actual-stop-generation-1' }
  Object.assign(f.lifecycle, { cancelledTaskCleanupEvidence: async (requested: string) => requested === taskId && state.intent === 'cancelled' && state.settled
    ? { commandId: state.commandId, signature: state.signature } : undefined })
  return state
}
test('explicit cancelled and actually settled Local Task can clear history without pretending its business completed', async t => {
  const f = await fixture(t), task = await f.seedTask(id, 'running', false), control = cancellation(f)
  await f.put([{ path: paths.run(id) + '/A/Inbox.md', content: 'Old unfinished local assignment' },
    { path: 'state/A/' + id + '/recovery', content: 'Retained technical recovery ownership' },
    { path: 'skills/keep/SKILL.md', content: 'Long skill' }, { path: 'debug/keep.log', content: 'Independent diagnostic history' },
    { path: f.conversation.foregroundRoot + '/Foreground_List.md', content: 'Long front planning' }])
  const preview = await f.cleanup().previewTasks()
  assert.deepEqual(preview.tasks.map(task => task.taskId), [id]); assert.equal(f.releases(), 0, 'preview is read-only')
  const result = await f.cleanup().clearTasks('clear-cancelled-history', preview, 'clear-ended-task-records')
  assert.equal(result.cleared, true); assert.equal(control.intent, 'cancelled', 'module does not release the cancellation hold before the confirmed receipt')
  assert.equal(JSON.parse((await f.read(paths.task(id)))!).status, 'running')
  const receipt = JSON.parse((await f.read(cleanupRecordPath(id)))!)
  assert.equal(receipt.phase, 'released'); assert.equal(receipt.historyCleared, true); assert.equal(receipt.taskId, id)
  assert.deepEqual(receipt.manualCancellation, { commandId: control.commandId, signature: control.signature })
  assert.ok(receipt.retentionHash.startsWith('manual:'), 'manual retirement is not misrepresented as a Recorder retention manifest')
  for (const path of [task.sourcePath, paths.run(id) + '/A/Inbox.md', paths.archive(id) + '/records.md']) assert.equal(await f.read(path), undefined, path)
  for (const path of ['state/A/' + id + '/recovery', 'skills/keep/SKILL.md', 'debug/keep.log', f.conversation.foregroundRoot + '/Foreground_List.md']) assert.notEqual(await f.read(path), undefined, path)
  assert.deepEqual(await withSnapshot(f.files, snapshot => f.files.readBytes(snapshot, task.resultPaths![0]!)), Uint8Array.from([0, 255, 128]))
  assert.deepEqual((await f.cleanup().previewTasks()).tasks, [])
})


test('paused, resumed and unconfirmed producers never authorize cancelled Task cleanup', async t => {
  const f = await fixture(t); await f.seedTask(id, 'running', false)
  const state = cancellation(f), cleanup = f.cleanup()
  for (const intent of ['paused', 'running']) {
    state.intent = intent
    assert.deepEqual((await cleanup.previewTasks()).tasks, [])
  }
  state.intent = 'cancelled'; state.settled = false
  assert.deepEqual((await cleanup.previewTasks()).tasks, [])
  assert.equal(f.releases(), 0)
  assert.notEqual(await f.read(paths.archive(id) + '/records.md'), undefined)
  assert.equal(await f.read(cleanupRecordPath(id)), undefined)
})

test('resumed Task or changed cancellation and producer generation invalidates the reviewed cleanup', async t => {
  for (const change of ['resume', 'command', 'producer']) await t.test(change, async t => {
    const f = await fixture(t); await f.seedTask(id, 'running', false)
    const state = cancellation(f), preview = await f.cleanup().previewTasks()
    if (change === 'resume') state.intent = 'running'
    else if (change === 'command') state.commandId = 'later-user-cancel'
    else state.signature = 'later-native-producer'
    await assert.rejects(f.cleanup().clearTasks('old-selection', preview, 'clear-ended-task-records'), /preview changed/)
    assert.equal(f.releases(), 0)
    assert.notEqual(await f.read(paths.archive(id) + '/records.md'), undefined)
    assert.equal(await f.read(cleanupRecordPath(id)), undefined)
  })
})

test('cancelled cleanup does not accept a changed producer or release of cancel hold during preparation', async t => {
  for (const change of ['generation', 'release']) await t.test(change, async t => {
    const f = await fixture(t); await f.seedTask(id, 'running', false)
    const state = cancellation(f), preview = await f.cleanup().previewTasks()
    f.lifecycle.prepareTaskCleanup = async () => {
      if (change === 'generation') state.signature = 'new-native-generation'
      else state.intent = 'running'
    }
    await assert.rejects(f.cleanup().clearTasks('prepare-changed', preview, 'clear-ended-task-records'), /ownership changed/)
    assert.notEqual(await f.read(paths.archive(id) + '/records.md'), undefined)
    assert.equal(await f.read(cleanupRecordPath(id)), undefined)
  })
})

test('cancelled cleanup reports failed or malformed settlement observations instead of assuming release', async t => {
  const f = await fixture(t); await f.seedTask(id, 'running', false); cancellation(f)
  f.lifecycle.cancelledTaskCleanupEvidence = async () => ({ commandId: 'cancel', signature: '' })
  await assert.rejects(f.cleanup().previewTasks(), /exact cancellation/)
  const error = new Error('Native stop acknowledgement is unavailable')
  f.lifecycle.cancelledTaskCleanupEvidence = async () => { throw error }
  await assert.rejects(f.cleanup().previewTasks(), failure => failure === error)
  cancellation(f); const preview = await f.cleanup().previewTasks()
  f.lifecycle.prepareTaskCleanup = async () => { throw error }
  await assert.rejects(f.cleanup().clearTasks('stop-failed', preview, 'clear-ended-task-records'), failure => failure === error)
  assert.notEqual(await f.read(paths.archive(id) + '/records.md'), undefined)
  assert.equal(await f.read(cleanupRecordPath(id)), undefined)
})

test('cancelled Task source ownership is the actual first-line UUID, not its reused submission filename', async t => {
  const f = await fixture(t), task = await f.seedTask(id, 'running', false); cancellation(f)
  await f.seedTask(other, 'running', false)
  const laterSource = 'Task ID: ' + other + '\nNew independent task original request'
  await f.put([{ path: task.sourcePath, content: laterSource }])
  const preview = await f.cleanup().previewTasks()
  assert.deepEqual(preview.tasks.map(task => task.taskId), [id])
  await f.cleanup().clearTasks('reused-submission', preview, 'clear-ended-task-records')
  assert.equal(await f.read(task.sourcePath), laterSource)
  assert.notEqual(await f.read(paths.archive(other) + '/records.md'), undefined)
})

test('a source replaced after cancelled cleanup preview is not deleted under the old fixed version', async t => {
  const f = await fixture(t), task = await f.seedTask(id, 'running', false); cancellation(f)
  const preview = await f.cleanup().previewTasks()
  const laterSource = 'Task ID: ' + other + '\nNew independent task original request'
  await f.put([{ path: task.sourcePath, content: laterSource }])
  await assert.rejects(f.cleanup().clearTasks('source-replaced', preview, 'clear-ended-task-records'), /preview changed/)
  assert.equal(await f.read(task.sourcePath), laterSource)
  assert.notEqual(await f.read(paths.archive(id) + '/records.md'), undefined)
})

test('cancelled cleanup rechecks settlement after fixed plan persistence and at final dispatch', async t => {
  for (const boundary of ['after-plan', 'after-body-reads']) await t.test(boundary, async t => {
    const f = await fixture(t); await f.seedTask(id, 'running', false)
    const state = cancellation(f), preview = await f.cleanup().previewTasks()
    if (boundary === 'after-plan') {
      const commit = f.files.commit.bind(f.files)
      f.files.commit = async (snapshot, changes, message) => {
        const receipt = await commit(snapshot, changes, message)
        if (changes.some(change => change.path.startsWith('technical/manual-cleanup/commands/'))) state.signature = 'late-producer'
        return receipt
      }
    } else {
      const read = f.files.read.bind(f.files); let sawPlan = false, reads = 0
      f.files.read = async (snapshot, path) => {
        const content = await read(snapshot, path)
        if (path.startsWith('technical/manual-cleanup/commands/') && content !== undefined) sawPlan = true
        // Apply reads the receipt once to determine eligibility, then once to
        // construct retirement. Change ownership only after its candidate check.
        if (sawPlan && path === cleanupRecordPath(id) && ++reads === 2) state.signature = 'late-producer'
        return content
      }
    }
    await assert.rejects(f.cleanup().clearTasks('final-evidence-check', preview, 'clear-ended-task-records'), /cleanup changed|ownership changed/)
    assert.notEqual(await f.read(paths.archive(id) + '/records.md'), undefined)
    assert.equal(await f.read(cleanupRecordPath(id)), undefined)
  })
})

test('committed cancelled cleanup survives lost acknowledgement and replay after controls release without a new retirement', async t => {
  const f = await fixture(t); await f.seedTask(id, 'running', false)
  const state = cancellation(f), preview = await f.cleanup().previewTasks(), commit = f.files.commit.bind(f.files)
  let lost = false
  f.files.commit = async (snapshot, changes, message) => {
    const receipt = await commit(snapshot, changes, message)
    if (!lost && changes.some(change => change.path === cleanupRecordPath(id))) {
      lost = true; throw new FilesOutcomeUnknownError('actual-cancelled-cleanup-commit', undefined, receipt)
    }
    return receipt
  }
  await assert.rejects(f.cleanup().clearTasks('cancelled-commit-lost', preview, 'clear-ended-task-records'), FilesOutcomeUnknownError)
  const retirement = await f.read(cleanupRecordPath(id))
  assert.equal(JSON.parse(retirement!).historyCleared, true)
  state.intent = 'running'
  f.lifecycle.prepareTaskCleanup = async () => { throw new Error('Do not retire a new execution on completed module replay') }
  await f.put([{ path: paths.archive(id) + '/later-user-output.txt', content: 'Later preserved user material' }])
  const result = await f.cleanup().clearTasks('cancelled-commit-lost', preview, 'clear-ended-task-records')
  assert.equal(result.receipt.replay, true)
  assert.equal(await f.read(cleanupRecordPath(id)), retirement)
  assert.equal(await f.read(paths.archive(id) + '/later-user-output.txt'), 'Later preserved user material')
})

test('uncommitted UNKNOWN cannot delete a resumed Task even at unchanged Files revision', async t => {
  const f = await fixture(t); await f.seedTask(id, 'running', false)
  const state = cancellation(f), preview = await f.cleanup().previewTasks(), commit = f.files.commit.bind(f.files)
  let lost = false
  f.files.commit = async (snapshot, changes, message) => {
    if (!lost && changes.some(change => change.path === cleanupRecordPath(id))) {
      lost = true; throw new FilesOutcomeUnknownError('cancelled-cleanup-not-committed')
    }
    return commit(snapshot, changes, message)
  }
  await assert.rejects(f.cleanup().clearTasks('cancelled-unknown', preview, 'clear-ended-task-records'), FilesOutcomeUnknownError)
  const revision = await withSnapshot(f.files, async snapshot => snapshot.revision)
  state.intent = 'running'
  assert.equal(await withSnapshot(f.files, async snapshot => snapshot.revision), revision)
  await assert.rejects(f.cleanup().clearTasks('cancelled-unknown', preview, 'clear-ended-task-records'), /cleanup changed/)
  assert.notEqual(await f.read(paths.archive(id) + '/records.md'), undefined)
  assert.equal(await f.read(cleanupRecordPath(id)), undefined)
})

test('cancelled fixed plan refuses late original history writes instead of deleting unseen content', async t => {
  const f = await fixture(t); await f.seedTask(id, 'running', false); cancellation(f)
  const preview = await f.cleanup().previewTasks(), commit = f.files.commit.bind(f.files)
  let interrupted = false
  f.files.commit = async (snapshot, changes, message) => {
    if (!interrupted && changes.some(change => change.path === cleanupRecordPath(id))) {
      interrupted = true; throw new Error('Controlled plan-to-apply exit')
    }
    return commit(snapshot, changes, message)
  }
  await assert.rejects(f.cleanup().clearTasks('late-cancelled-write', preview, 'clear-ended-task-records'), /plan-to-apply/)
  await f.put([{ path: paths.run(id) + '/A/Planner_Memory.md', content: 'New producer fact' }])
  await assert.rejects(f.cleanup().resumePending(), FilesConflictError)
  await assert.rejects(f.cleanup().resumePending(), /cleanup changed/)
  assert.equal(await f.read(paths.run(id) + '/A/Planner_Memory.md'), 'New producer fact')
  assert.equal(await f.read(cleanupRecordPath(id)), undefined)
})
