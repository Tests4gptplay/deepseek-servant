import test from 'node:test'
import assert from 'node:assert/strict'
import { ServantStore } from '../src/application/servant-store.js'
import { TaskService } from '../src/application/task-service.js'
import type { ExecutionReportInput, TaskCommand, CommandSource } from '../src/contracts/task.js'
import { fixture, childSpec } from './task-fixture.js'

async function reported() {
  const f = await fixture(), planner = await f.bind('plan')
  assert.equal((await f.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 0,
    strategy: 'One bounded worker', children: [childSpec()] }, planner.source)).status, 'applied')
  await f.execute({ type: 'execution.observed', executionId: planner.execution.executionId, physicalState: 'stopped', ownedJobIds: [] })
  const worker = await f.bind('dispatch', 'a')
  const report: ExecutionReportInput = { resultId: 'durable-progress', assignmentVersion: 1, outcome: 'progress',
    summary: 'Same durable progress', artifacts: [
      { id: 'first', path: 'first.json', sha256: 'a'.repeat(64), description: 'First artifact', resultId: 'durable-progress', version: '1' },
      { id: 'second', path: 'second.json', sha256: 'b'.repeat(64), description: 'Second artifact' },
    ], evidence: ['first proof', 'second proof'], frontier: 'Continue after replay',
    wait: { id: 'optional-wait', kind: 'resource', reason: 'Recorded context', condition: 'Resource ready', resume: 'worker' },
    checkpoint: { completed: ['first', 'second'], failedApproaches: [{ approach: 'old', outcome: 'not used', evidence: ['checked'] }],
      remaining: ['third'], nextAction: 'Continue', nextReads: ['first.json', 'second.json'] } }
  assert.equal((await f.execute({ type: 'execution.report', report }, worker.source, 'first-report')).status, 'applied')
  // Reconstruct actual production stores. TaskRecords has persisted each report as
  // canonical RecordJournal text; this is not a hand-sorted report mock.
  const store = new ServantStore(f.storage), tasks = new TaskService(store)
  const persisted = (await tasks.get('one'))!
  assert.notDeepEqual(Object.keys(persisted.reports[report.resultId].artifacts[0]), Object.keys(report.artifacts[0]),
    'The real journal roundtrip must reproduce artifact key reordering')
  assert.deepEqual(persisted.reports[report.resultId].artifacts, report.artifacts)
  const journalEntries = await store.journal.entries({ kind: 'worker-reply', taskId: 'one', childId: 'a' })
  assert.equal(journalEntries.length, 1)
  let events = 0
  tasks.subscribe(() => { events++ })
  let command = 0
  const replay = (payload = report, source: CommandSource = worker.source) => tasks.execute('one', {
    type: 'execution.report', report: payload, source, commandId: 'replay-' + ++command,
  } as TaskCommand)
  const baseline = { revision: persisted.revision, writes: f.storage.writes.length, records: f.storage.data.size,
    reports: Object.keys(persisted.reports), actions: persisted.pendingActions }
  const unchanged = async () => {
    const current = (await tasks.get('one'))!
    assert.equal(current.revision, baseline.revision)
    assert.deepEqual(Object.keys(current.reports), baseline.reports)
    assert.deepEqual(current.pendingActions, baseline.actions)
    assert.equal((await store.journal.entries({ kind: 'worker-reply', taskId: 'one', childId: 'a' })).length, 1)
    assert.equal(f.storage.writes.length, baseline.writes)
    assert.equal(f.storage.data.size, baseline.records)
    assert.equal(events, 0)
  }
  return { report, worker, replay, unchanged }
}
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]))
  return value
}
test('real RecordJournal reload accepts identical result under a new command without revision, events or extra records', async () => {
  const f = await reported()
  assert.equal((await f.replay()).status, 'duplicate')
  assert.equal((await f.replay(reverseKeys(f.report) as ExecutionReportInput)).status, 'duplicate')
  const optionalUndefined = structuredClone(f.report)
  optionalUndefined.artifacts[1].version = undefined
  optionalUndefined.wait!.question = undefined
  assert.equal((await f.replay(optionalUndefined)).status, 'duplicate')
  await f.unchanged()
})
test('same resultId still rejects changed artifact payload and primitive type after journal reload', async () => {
  const f = await reported()
  for (const change of [
    (r: ExecutionReportInput) => { r.artifacts[0].sha256 = 'c'.repeat(64) },
    (r: ExecutionReportInput) => { r.artifacts[0].version = 1 as unknown as string },
    (r: ExecutionReportInput) => { r.checkpoint!.failedApproaches[0].outcome = 'changed' },
  ]) {
    const changed = structuredClone(f.report); change(changed)
    assert.equal((await f.replay(changed)).code, 'RESULT_ID_REUSED')
  }
  await f.unchanged()
})
test('array order and result ownership remain significant after journal reload', async () => {
  const f = await reported()
  for (const change of [
    (r: ExecutionReportInput) => { r.artifacts.reverse() },
    (r: ExecutionReportInput) => { r.evidence.reverse() },
    (r: ExecutionReportInput) => { r.checkpoint!.completed.reverse() },
    (r: ExecutionReportInput) => { r.checkpoint!.nextReads.reverse() },
    (r: ExecutionReportInput) => { r.assignmentVersion++ },
  ]) {
    const changed = structuredClone(f.report); change(changed)
    assert.equal((await f.replay(changed)).code, 'RESULT_ID_REUSED')
  }
  assert.equal((await f.replay(f.report, { ...f.worker.source, id: 'another-agent' })).code, 'RESULT_ID_REUSED')
  await f.unchanged()
})
