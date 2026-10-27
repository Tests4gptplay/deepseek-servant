import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportTaskRecords } from '../src/application/task-record-export.js'
import { RetentionService } from '../src/application/retention-service.js'
import { childSpec, fixture } from './task-fixture.js'
import { RuntimeCoordinator, type CoordinatorOptions } from '../src/runtime/coordinator.js'
import { TaskArchiveStore } from '../src/application/task-archive-store.js'
import { taskRecordPrefixes } from '../src/application/record-journal.js'
import { taskInput } from './support.js'

async function accepted() {
  const f = await fixture(), planner = await f.bind('plan')
  assert.equal((await f.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 0,
    strategy: 'Produce and accept the requested artifact', children: [childSpec()] }, planner.source)).status, 'applied')
  const worker = await f.bind('dispatch')
  assert.equal((await f.execute({ type: 'execution.report', report: { resultId: 'accepted-output', assignmentVersion: 1,
    outcome: 'complete', summary: 'Result saved', artifacts: [{ id: 'file', path: 'result.txt', description: 'Requested output' }],
    evidence: ['Actual output matches the requested content'], frontier: 'Ready for review' } }, worker.source)).status, 'applied')
  const evaluator = await f.bind('evaluate')
  assert.equal((await f.execute({ type: 'planning.decide', expectedGoalRevision: 1, summary: 'Entire Root Goal is complete',
    decisions: [{ childId: 'a', resultId: 'accepted-output', outcome: 'accept', reason: 'All requested content present' }],
    deliver: { id: 'delivery-one', summary: 'Finished result.txt', artifacts: [{ id: 'file', path: 'result.txt', description: 'Requested output' }] } }, evaluator.source)).status, 'applied')
  for (const execution of Object.values((await f.get()).executions)) assert.equal((await f.execute({
    type: 'execution.observed', executionId: execution.executionId, physicalState: 'stopped', ownedJobIds: [],
  })).status, 'applied')
  return f
}
async function finish(f: Awaited<ReturnType<typeof accepted>>) {
  for (const action of Object.values((await f.get()).pendingActions).filter(action => action.status === 'pending')) {
    assert.equal((await f.execute({ type: 'action.claim', actionId: action.id, ownerId: 'runtime' })).status, 'applied')
    assert.equal((await f.execute({ type: 'action.finish', actionId: action.id, notificationId: action.kind === 'deliver' ? 'stable-wake' : undefined })).status, 'applied')
  }
}
test('archived read acknowledgments, Markdown export and manual hiding retain all record evidence', async () => {
  const f = await accepted()
  await finish(f)
  const original = 'Exact Unicode 🙂\n\u0060\u0060\u0060markdown\nbody\n\u0060\u0060\u0060'
  const memory = await f.store.journal.append({ scope: { kind: 'planner-memory', taskId: 'one' },
    commandId: 'export-memory', text: original, source: f.runtime })
  await f.tasks.cleanupCompleted('one')
  let acknowledged = 0
  f.tasks.subscribe(task => { if (task.delivery?.readAt) acknowledged++ })
  await f.tasks.execute('one', { type: 'delivery.read', commandId: 'read-completion', source: { kind: 'user', id: 'owner' } })
  assert.ok((await f.tasks.get('one'))?.delivery?.readAt)
  assert.equal(acknowledged, 1)
  const directory = await mkdtemp(join(tmpdir(), 'dss-record-export-'))
  try {
    const exported = await exportTaskRecords(f.tasks.archives, 'one', directory)
    const body = await readFile(exported.path)
    assert.equal(body.length, exported.bytes)
    assert.equal(createHash('sha256').update(body).digest('hex'), exported.sha256)
    assert.ok(body.toString('utf8').includes(original))
    assert.deepEqual(await exportTaskRecords(f.tasks.archives, 'one', directory), exported)
    await writeFile(exported.path, 'Existing user content')
    await assert.rejects(exportTaskRecords(f.tasks.archives, 'one', directory), /different content/)
    assert.equal(await readFile(exported.path, 'utf8'), 'Existing user content')
  } finally { await rm(directory, { recursive: true, force: true }) }
  const retention = new RetentionService({ store: f.storage, tasks: f.tasks, completedTasks: f.tasks,
    knowledge: { withRetentionLock: work => work({ listSkills: async () => [], compactSkill: async () => ({ status: 'unchanged', reclaimedBytes: 0 }) }) } })
  const preview = await retention.preview({ manual: true })
  assert.deepEqual(preview.deleteArchives.map(row => row.taskId), ['one'])
  const cleaned = await retention.sweep({ previewId: preview.previewId })
  assert.deepEqual(cleaned.deletedArchives, ['one'])
  assert.equal((await f.tasks.history()).length, 0)
  assert.equal((await f.tasks.history(true)).length, 1)
  assert.equal(await f.store.journal.fullText(memory.ref), original)
  assert.equal((await f.tasks.get('one'))?.reports['accepted-output']?.disposition, 'accepted')
  assert.ok(await f.tasks.archives.manifest('one'))
})

async function document(archives: TaskArchiveStore, id: string) {
  let text = '', cursor: number | undefined = 0
  do { const page = await archives.read(id, cursor, 8192); text += page.text; cursor = page.nextCursor } while (cursor !== undefined)
  return text
}

test('T23/T24: seal full records before foreground wake; automatically release exact Task-owned temporary keys', { timeout: 10000 }, async () => {
  const f = await accepted(), longText = '完整原文🙂\n'.repeat(6000) + 'END OF MEMORY'
  const memory = await f.store.journal.append({ scope: { kind: 'planner-memory', taskId: 'one' },
    commandId: 'long-memory', text: longText, source: f.runtime })
  await f.storage.set('knowledge/preserved', { text: 'Remembered method' })
  await f.storage.set('conversations/assistant/2026-10-26/original', { text: 'Conversation original' })
  await f.storage.set('planner-memory/one-other/content/keep', { text: 'Other task' })
  const originals = new Map([...f.storage.data].filter(([key]) => key.startsWith('task-origin/')))
  let wakes = 0, resolve!: () => void, reject!: (error: unknown) => void
  const completed = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  const coordinator = new RuntimeCoordinator({
    tasks: f.tasks,
    assistants: { deliver: async () => {
      const records = await f.tasks.archives.manifest('one')
      assert.equal(records?.state, 'sealed')
      assert.equal(records.stage, 'accepted')
      const text = await document(f.tasks.archives, 'one')
      assert.ok(text.includes(longText))
      assert.equal(createHash('sha256').update(text).digest('hex'), records.sha256)
      wakes++
      return 'stable-wake'
    } },
    knowledge: { listSkills: async () => [] },
    supervisor: { live: () => [], get: () => undefined },
    sessions: {},
    onError: reject,
    onChanged: () => { void f.tasks.archives.index('one').then(index => { if (index?.cleanedAt) resolve() }, reject) },
  } as unknown as CoordinatorOptions)
  try {
    await coordinator.start(); await completed
    assert.equal(wakes, 1)
    assert.equal(await f.storage.get('task:one'), undefined)
    for (const prefix of taskRecordPrefixes('one')) assert.equal((await f.storage.list(prefix)).length, 0, prefix)
    for (const [key, value] of originals) assert.deepEqual(await f.storage.get(key), value)
    assert.equal((await f.storage.get<{ text: string }>('knowledge/preserved'))?.text, 'Remembered method')
    assert.ok(await f.storage.get('planner-memory/one-other/content/keep'))
    assert.ok(await f.storage.get('conversations/assistant/2026-10-26/original'))
    assert.equal(await f.store.journal.fullText(memory.ref), longText)
    assert.ok((await f.store.journal.page({ kind: 'planner-memory', taskId: 'one' })).entries.some(entry => entry.ref === memory.ref))
    assert.equal((await f.tasks.get('one'))?.delivery?.notificationId, 'stable-wake')
    assert.equal((await f.tasks.history()).length, 1)
    assert.equal((await f.tasks.submit(taskInput())).code, 'TASK_RETIRED')
  } finally { await coordinator.dispose() }
})

test('T25: a failed archive write leaves runtime originals intact; retry seals and completes cleanup', async () => {
  const f = await accepted()
  await finish(f)
  f.storage.fail = key => key === 'records/one/manifest'
  await assert.rejects(f.tasks.cleanupCompleted('one'), /Injected storage interruption/)
  assert.ok(await f.storage.get('task:one'))
  assert.ok((await f.storage.list('worker-reply/one/')).length)
  assert.equal(await f.tasks.archives.index('one'), undefined)
  f.storage.fail = undefined
  assert.equal(await f.tasks.cleanupCompleted('one'), true)
  assert.equal((await f.tasks.get('one'))?.phase, 'completed')
})

test('restart cleanup preserves a task updated after its archive was sealed', async () => {
  for (const newer of [false, true]) {
    const f = await accepted()
    await finish(f)
    f.storage.fail = key => key === 'task:one'
    await assert.rejects(f.tasks.cleanupCompleted('one'), /Injected storage interruption/)
    f.storage.fail = undefined
    const original = (await f.storage.get<any>('task:one'))!
    const current = newer ? { ...original, revision: original.revision + 1 } : original
    if (newer) await f.storage.set('task:one', current)
    const errors: unknown[] = []
    const restarted = new TaskArchiveStore(f.storage)
    await restarted.resumeCleanup(error => errors.push(error))
    if (newer) {
      assert.deepEqual(await f.storage.get('task:one'), current)
      assert.ok((await f.storage.list('worker-reply/one/')).length)
      assert.equal(errors.length, 1)
      assert.equal((await restarted.index('one'))?.cleanedAt, undefined)
    } else {
      assert.equal(await f.storage.get('task:one'), undefined)
      assert.equal(errors.length, 0)
      assert.ok((await restarted.index('one'))?.cleanedAt)
    }
  }
})

test('T26: interrupted exact-key cleanup resumes after restart from the sealed manifest and replay fence', async () => {
  const f = await accepted()
  await finish(f)
  const remove = f.storage.delete.bind(f.storage)
  let interrupted = false
  f.storage.delete = async key => {
    if (!interrupted && key.startsWith('worker-reply/one/')) { interrupted = true; throw new Error('Interrupted deletion') }
    await remove(key)
  }
  await assert.rejects(f.tasks.cleanupCompleted('one'), /Interrupted deletion/)
  assert.equal((await f.tasks.submit(taskInput())).code, 'TASK_RETIRED')
  const restarted = new TaskArchiveStore(f.storage)
  await restarted.resumeCleanup()
  assert.equal(await f.storage.get('task:one'), undefined)
  assert.ok((await restarted.index('one'))?.cleanedAt)
  assert.ok((await document(restarted, 'one')).includes('Actual output matches the requested content'))
})
