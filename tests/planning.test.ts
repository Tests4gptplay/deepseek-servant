import test from 'node:test'
import assert from 'node:assert/strict'
import { childSpec, fixture } from './task-fixture.js'
import type { CommandSource } from '../src/contracts/task.js'

test('T05/T06: incremental addition preserves accepted and running Children; validates the combined DAG', async () => {
  const f = await fixture(), p1 = await f.bind('plan')
  assert.equal((await f.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 0,
    strategy: 'Initial', children: [childSpec('a')] }, p1.source)).status, 'applied')
  const worker = await f.bind('dispatch', 'a')
  await f.execute({ type: 'execution.report', report: { resultId: 'done-a', assignmentVersion: 1, outcome: 'complete',
    summary: 'Done', artifacts: [], evidence: ['Output inspected'], frontier: 'Next stage' } }, worker.source)
  const evaluator = await f.bind('evaluate')
  assert.equal((await f.execute({ type: 'planning.decide', expectedGoalRevision: 1, summary: 'Accepted',
    decisions: [{ childId: 'a', resultId: 'done-a', outcome: 'accept', reason: 'Actual output matches' }] }, evaluator.source)).status, 'applied')
  const p2 = await f.bind('plan')
  assert.equal((await f.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 1,
    strategy: 'Incremental next stage', children: [childSpec('b', ['a']), childSpec('c')] }, p2.source)).status, 'applied')
  let task = await f.get()
  assert.deepEqual(task.plan.childIds, ['a', 'b', 'c'])
  assert.equal(task.children.a.acceptedResultId, 'done-a')
  assert.ok(Object.values(task.pendingActions).some(action => action.kind === 'dispatch' && action.payload.childId === 'b' && action.status === 'pending'))
  const b = await f.bind('dispatch', 'b'), c = await f.bind('dispatch', 'c')
  await f.execute({ type: 'execution.report', report: { resultId: 'done-c', assignmentVersion: 1, outcome: 'complete',
    summary: 'Done', artifacts: [], evidence: ['Verified'], frontier: 'Review' } }, c.source)
  const p3 = await f.bind('evaluate')
  assert.equal((await f.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 2,
    strategy: 'Cycle', children: [childSpec('d', ['b'])], updates: [childSpec('b', ['d'])] }, p3.source)).code, 'DEPENDENCY_CYCLE')
  assert.equal((await f.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 2,
    strategy: 'Invalid dependency removal', children: [], cancelChildIds: ['a'] }, p3.source)).code, 'MISSING_DEPENDENCY')
  assert.equal((await f.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 2,
    strategy: 'Additional independent work', children: [childSpec('d')] }, p3.source)).status, 'applied')
  task = await f.get()
  assert.equal(task.children.b.activeExecutionId, b.execution.executionId)
  assert.equal(task.children.b.assignmentVersion, 1)
  assert.equal(task.children.a.status, 'accepted')
  assert.equal(task.children.d.status, 'pending')
})

test('T09: Planner handoff resumes the same action and result set only after old owner settles', async () => {
  const f = await fixture(), first = await f.bind('plan')
  const receipt = await f.execute({ type: 'planning.handoff', expectedGoalRevision: 1,
    summary: 'Useful reasoning persisted', frontier: 'Continue exact unfinished plan' }, first.source, 'handoff')
  assert.equal(receipt.status, 'applied')
  let task = await f.get()
  assert.equal(task.executions[first.execution.executionId].state, 'closed')
  assert.equal(task.pendingActions[first.action.id].status, 'pending')
  assert.equal((await f.execute({ type: 'action.claim', actionId: first.action.id, ownerId: 'new' })).code, 'HANDOFF_OWNER_ACTIVE')
  await f.execute({ type: 'execution.observed', executionId: first.execution.executionId, physicalState: 'stopped', ownedJobIds: [] })
  const second = await f.bind('plan')
  assert.equal(second.action.id, first.action.id)
  assert.equal(second.execution.generation, 2)
  assert.notEqual(second.execution.sessionId, first.execution.sessionId)
  task = await f.get()
  assert.equal(task.plan.revision, 0)
  assert.equal(task.decisions.length, 1)
  assert.equal((await f.execute({ type: 'planning.handoff', expectedGoalRevision: 1,
    summary: 'Useful reasoning persisted', frontier: 'Continue exact unfinished plan' }, first.source, 'handoff')).status, 'duplicate')
})

test('T10/T11: sixteen effective segments with two handoffs review at 5, 10, 15; progress does not count', async () => {
  const f = await fixture(), p = await f.bind('plan')
  await f.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 0, strategy: 'Long task', children: [childSpec()] }, p.source)
  let worker = await f.bind('dispatch'), source: CommandSource = worker.source
  const reviews: number[] = [], sessions = new Set([worker.execution.sessionId])
  for (let segment = 1; segment <= 16; segment++) {
    for (let checkpoint = 0; checkpoint < 2; checkpoint++) assert.equal((await f.execute({ type: 'execution.report', report: {
      resultId: 'progress-' + segment + '-' + checkpoint, assignmentVersion: 1, outcome: 'progress', summary: 'In-turn detail',
      artifacts: [], evidence: [], frontier: 'Keep working' } }, source)).status, 'applied')
    assert.equal((await f.get()).children.a.progressSegments, segment - 1)
    const handoff = segment === 7 || segment === 12
    const resultId = 'segment-' + segment
    assert.equal((await f.execute({ type: 'execution.report', report: { resultId, assignmentVersion: 1, outcome: handoff ? 'handoff' : 'continue',
      summary: 'Work segment', artifacts: [], evidence: ['Actual progress'], frontier: 'Next concrete action',
      ...(handoff ? { checkpoint: { completed: ['Done'], failedApproaches: [], remaining: ['More'], nextAction: 'Continue', nextReads: [] } } : {}) } }, source)).status, 'applied')
    let task = await f.get()
    const review = Object.values(task.pendingActions).find(action => action.kind === 'evaluate' && action.status === 'pending')
    if (review) {
      reviews.push(segment)
      const evaluator = await f.bind('evaluate')
      assert.equal((await f.execute({ type: 'planning.decide', expectedGoalRevision: 1, summary: 'Method remains sound',
        decisions: [{ childId: 'a', resultId, outcome: 'continue', reason: 'Verified progress' }] }, evaluator.source)).status, 'applied')
    }
    if (handoff) {
      await f.execute({ type: 'execution.observed', executionId: worker.execution.executionId, physicalState: 'stopped', ownedJobIds: [] })
      worker = await f.bind('dispatch'); source = worker.source; sessions.add(worker.execution.sessionId)
    } else {
      task = await f.get()
      const continuation = Object.values(task.pendingActions).find(action => action.kind === 'continue' && action.status === 'pending')!
      assert.ok(continuation)
      assert.equal(continuation.payload.executionId, worker.execution.executionId)
      await f.execute({ type: 'action.claim', actionId: continuation.id, ownerId: 'runtime' })
      await f.execute({ type: 'action.finish', actionId: continuation.id })
    }
  }
  assert.deepEqual(reviews, [5, 10, 15])
  assert.equal(sessions.size, 3)
  assert.equal((await f.get()).children.a.progressSegments, 16)
})
