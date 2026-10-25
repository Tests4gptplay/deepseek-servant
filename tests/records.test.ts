import test from 'node:test'
import assert from 'node:assert/strict'
import { RecordJournal } from '../src/application/record-journal.js'
import { ServantStore } from '../src/application/servant-store.js'
import { TaskService } from '../src/application/task-service.js'
import type { Task } from '../src/contracts/task.js'
import { MemoryStorage, taskInput } from './support.js'

const source = { kind: 'runtime' as const, id: 'test' }
test('T02/T03: more than 100 full entries, 1 MiB bodies, paging and lost-receipt retries', async () => {
  const storage = new MemoryStorage(), journal = new RecordJournal(storage)
  const scope = { kind: 'planner-memory' as const, taskId: 'task/a' }
  const text = '原文🙂\n'.repeat(150_000)
  const first = await journal.append({ scope, commandId: 'one', source, text })
  assert.equal((await journal.append({ scope, commandId: 'one', source, text })).ref, first.ref)
  for (let index = 0; index < 120; index++) await journal.append({ scope, commandId: 'next-' + index, source, text: 'entry ' + index })
  assert.equal((await journal.page(scope)).revision, 121)
  assert.equal(await journal.fullText(first.ref), text)
  const read = await journal.read(first.ref, 60_000, 60_000)
  assert.equal(read.text, text.slice(60_000, 120_000))
  assert.equal((await journal.search(scope, 'entry 119')).matches.length, 1)
  let cursor: number | undefined = 0, count = 0
  while (cursor !== undefined) { const page = await journal.page(scope, cursor, 17); count += page.entries.length; cursor = page.nextCursor }
  assert.equal(count, 121)
  await assert.rejects(journal.append({ scope, commandId: 'one', source, text: 'different' }), /COMMAND_ID_REUSED/)
  const reply = await journal.append({ scope: { kind: 'worker-reply', taskId: 'task/a', childId: 'child' }, commandId: 'reply', source, text })
  assert.equal(await journal.fullText(reply.ref), text)
})
test('T04: interrupted parts stay unpublished and the same append resumes once', async () => {
  const storage = new MemoryStorage(), scope = { kind: 'planner-note' as const, taskId: 'a' }
  storage.fail = key => key.endsWith('/1')
  await assert.rejects(new RecordJournal(storage).append({ scope, commandId: 'note', source, text: 'x'.repeat(200_000) }))
  assert.equal((await new RecordJournal(storage).page(scope)).entries.length, 0)
  storage.fail = undefined
  const journal = new RecordJournal(storage)
  const result = await journal.append({ scope, commandId: 'note', source, text: 'x'.repeat(200_000), expectedRevision: 0 })
  assert.equal(result.sequence, 1)
  await assert.rejects(journal.append({ scope, commandId: 'next', source, text: 'new', expectedRevision: 0 }), /STALE_RECORD_REVISION/)
})
async function legacyTask(): Promise<Task> {
  const storage = new MemoryStorage(), tasks = new TaskService(new ServantStore(storage))
  await tasks.submit(taskInput())
  const task = (await tasks.get('one'))!
  task.revision = 121
  task.decisions = Array.from({ length: 120 }, (_, index) => ({ commandId: 'decision-' + index, source,
    at: task.updatedAt, goalRevision: 1, sequence: index + 1, summary: '完整决策 ' + index }))
  task.plannerNote = { revision: 1, goalRevision: 1, commandId: 'note', updatedAt: task.updatedAt,
    frontier: 'Next action', body: '完整 Note🙂\n'.repeat(100_000) }
  return task
}
test('T01/T02: legacy v1 migration preserves full data and leaves a small hot Task', async () => {
  const original = await legacyTask(), storage = new MemoryStorage()
  await storage.set('task:one', original)
  await storage.set('assistant/untouched', { schemaVersion: 1, text: 'existing assistant' })
  await storage.set('knowledge/untouched', { text: 'existing knowledge' })
  const store = new ServantStore(storage)
  assert.deepEqual(await store.getTask('one'), original)
  assert.ok(JSON.stringify(storage.data.get('task:one')).length < 2000)
  assert.equal((await store.journal.page({ kind: 'planner-memory', taskId: 'one' }, 0, 100)).revision, 120)
  assert.deepEqual(await storage.get('assistant/untouched'), { schemaVersion: 1, text: 'existing assistant' })
  assert.deepEqual(await storage.get('knowledge/untouched'), { text: 'existing knowledge' })
  storage.writes = []
  const tasks = new TaskService(store)
  const receipt = await tasks.execute('one', { type: 'task.priority', commandId: 'priority', source: taskInput().source, priority: 3 })
  assert.equal(receipt.status, 'applied')
  assert.ok(storage.writes.every(write => JSON.stringify(write.value).length < 10_000), 'new work does not copy old large bodies')
  assert.equal((await tasks.get('one'))!.plannerNote!.body, original.plannerNote!.body)
})
test('T04: migration interruption retains the original root and resumes on restart', async () => {
  const original = await legacyTask(), storage = new MemoryStorage()
  await storage.set('task:one', original)
  storage.fail = key => key.startsWith('planner-memory/')
  await assert.rejects(new ServantStore(storage).getTask('one'), /Injected/)
  assert.deepEqual(storage.data.get('task:one'), original)
  storage.fail = undefined
  assert.deepEqual(await new ServantStore(storage).getTask('one'), original)
  assert.equal((await storage.list('task-staging/')).length, 0)
})
test('T03/T04: committed Task replay and half-written new Task recover without duplicate actions', async () => {
  const storage = new MemoryStorage()
  storage.fail = key => key === 'task:one'
  await assert.rejects(new TaskService(new ServantStore(storage)).submit(taskInput()), /Injected/)
  storage.fail = undefined
  const tasks = new TaskService(new ServantStore(storage))
  assert.equal((await tasks.list()).length, 1)
  const receipt = await tasks.submit(taskInput())
  assert.equal(receipt.status, 'duplicate')
  assert.equal(Object.keys((await tasks.get('one'))!.pendingActions).length, 1)
})
