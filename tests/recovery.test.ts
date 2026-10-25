import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, childSpec } from './task-fixture.js'
import { assembleRoleInput } from '../src/runtime/context-assembler.js'
import { Scheduler } from '../src/runtime/scheduler.js'

type Fixture = Awaited<ReturnType<typeof fixture>>
async function planned() {
  const f = await fixture()
  const planner = await f.bind('plan')
  assert.equal((await f.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 0, strategy: 'Preserve useful output', children: [childSpec()] }, planner.source)).status, 'applied')
  const worker = await f.bind('dispatch', 'a')
  return { ...f, planner, worker }
}
async function fault(f: Fixture, executionId: string) {
  assert.equal((await f.execute({ type: 'incident.open', executionId, operation: 'native Agent error', message: 'transport interrupted' })).status, 'applied')
  return Object.values((await f.get()).incidents).find(entry => entry.executionId === executionId)!
}
async function settle(f: Fixture, executionId: string) {
  assert.equal((await f.execute({ type: 'execution.observed', executionId, physicalState: 'lost', ownedJobIds: [] })).status, 'applied')
}
async function restart(f: Fixture, incidentId: string) {
  return f.execute({ type: 'recovery.restart', incidentId, evidence: 'Exact original owner and its native jobs have settled.' })
}
const pending = (task: Awaited<ReturnType<Fixture['get']>>, kind: string) => Object.values(task.pendingActions).filter(a => a.kind === kind && a.status === 'pending')

test('same-role recovery waits for exact owner/jobs, preserving assignment and generation', async () => {
  const f = await planned(), old = f.worker.execution
  const incident = await fault(f, old.executionId)
  assert.equal((await restart(f, incident.id)).code, 'OWNER_NOT_PROVEN_GONE')
  await f.execute({ type: 'execution.observed', executionId: old.executionId, physicalState: 'lost', ownedJobIds: ['render-1'] })
  assert.equal((await restart(f, incident.id)).code, 'OWNER_NOT_PROVEN_GONE')
  await settle(f, old.executionId)
  assert.equal((await restart(f, incident.id)).status, 'applied')
  const next = await f.bind('dispatch', 'a'), task = await f.get()
  assert.equal(next.execution.role, 'worker')
  assert.equal(next.execution.assignmentVersion, old.assignmentVersion)
  assert.equal(next.execution.generation, old.generation + 1)
  assert.notEqual(next.execution.sessionId, old.sessionId)
  assert.equal(task.children.a.progressSegments, 0)
  assert.equal(task.needsPlanning, false)
  assert.equal(Object.values(task.executions).some(e => e.role === 'helper'), false)
  assert.equal((await restart(f, incident.id)).status, 'duplicate')
})

test('saved progress, frontier and exact error are delivered to the replacement Worker', async () => {
  const f = await planned()
  await f.execute({ type: 'execution.report', report: { resultId: 'saved', assignmentVersion: 1, outcome: 'progress', summary: 'Mesh already repaired',
    artifacts: [{ id: 'mesh', path: 'a/mesh.blend', description: 'Saved repaired mesh' }], evidence: ['Reopened saved mesh'],
    checkpoint: { completed: ['Mesh repaired'], failedApproaches: [{ approach: 'Global replacement', outcome: 'Changed unrelated vertices', evidence: ['Original preserved'] }],
      remaining: ['Export retained mesh'], nextAction: 'Export saved mesh', nextReads: [] }, frontier: 'Export the saved mesh without remodeling' } }, f.worker.source)
  const incident = await fault(f, f.worker.execution.executionId)
  await settle(f, f.worker.execution.executionId)
  assert.equal((await restart(f, incident.id)).status, 'applied')
  const next = await f.bind('dispatch', 'a'), task = await f.get()
  const input = assembleRoleInput(task, next.execution, next.action)
  assert.equal(task.children.a.currentResultId, 'saved')
  assert.equal(input.handoff.recovery?.incidentId, incident.id)
  assert.equal(input.handoff.recovery?.errors[0].message, 'transport interrupted')
  assert.equal(input.handoff.predecessor?.executionId, f.worker.execution.executionId)
  assert.ok(JSON.stringify(input).includes('Export the saved mesh without remodeling'))
  assert.ok(input.handoff.next_reads.some(read => read.ref === input.handoff.recovery?.ref))
})

test('saved terminal report queues its evaluation instead of another Worker', async () => {
  const f = await planned()
  await f.execute({ type: 'execution.report', report: { resultId: 'finished', assignmentVersion: 1, outcome: 'complete', summary: 'Deliverable saved', artifacts: [], evidence: ['Saved artifact'], frontier: 'Evaluate saved deliverable' } }, f.worker.source)
  const incident = await fault(f, f.worker.execution.executionId)
  await settle(f, f.worker.execution.executionId)
  assert.equal((await restart(f, incident.id)).status, 'applied')
  const task = await f.get()
  assert.equal(task.children.a.status, 'reported')
  assert.equal(pending(task, 'dispatch').length, 0)
  assert.deepEqual(pending(task, 'evaluate').map(a => a.payload.resultIds), [['finished']])
})

test('fifth-segment review survives a later checkpoint and recovery', async () => {
  const f = await planned()
  for (let i = 1; i <= 5; i++) {
    assert.equal((await f.execute({ type: 'execution.report', report: { resultId: 'part-' + i, assignmentVersion: 1, outcome: 'continue', summary: 'Useful segment ' + i, artifacts: [], evidence: ['Retained output'], frontier: 'Next work segment' } }, f.worker.source)).status, 'applied')
    if (i < 5) {
      const continuation = pending(await f.get(), 'continue')[0]
      await f.execute({ type: 'action.claim', actionId: continuation.id, ownerId: 'runtime' })
      await f.execute({ type: 'action.finish', actionId: continuation.id })
    }
  }
  assert.equal((await f.execute({ type: 'execution.report', report: { resultId: 'extra-checkpoint', assignmentVersion: 1,
    outcome: 'progress', summary: 'Useful details saved after segment five', artifacts: [], evidence: ['Existing work retained'], frontier: 'Continue from supplemental checkpoint' } }, f.worker.source)).status, 'applied')
  const incident = await fault(f, f.worker.execution.executionId)
  await settle(f, f.worker.execution.executionId)
  assert.equal((await restart(f, incident.id)).status, 'applied')
  let task = await f.get()
  assert.equal(task.children.a.currentResultId, 'extra-checkpoint')
  assert.equal(task.children.a.progressSegments, 5)
  assert.equal(task.children.a.handoff?.reviewRequired, true)
  assert.equal(pending(task, 'dispatch').length, 0)
  const evaluator = await f.bind('evaluate')
  assert.equal((await f.execute({ type: 'planning.decide', expectedGoalRevision: 1, summary: 'Existing method remains sound',
    decisions: [{ childId: 'a', resultId: 'part-5', outcome: 'continue', reason: 'Continue retained frontier' }] }, evaluator.source)).status, 'applied')
  task = await f.get()
  assert.equal(task.children.a.handoff?.reviewRequired, false)
  const dispatch = pending(task, 'dispatch')[0]
  assert.ok(dispatch)
  assert.equal(new Scheduler().canRun(task, dispatch, [task], new Map()).allowed, true)
  const next = await f.bind('dispatch', 'a')
  assert.equal(next.execution.assignmentVersion, f.worker.execution.assignmentVersion)
  assert.equal((await f.get()).children.a.progressSegments, 5)
})

test('unchanged repeated faults wait for an explicit environment change', async () => {
  const f = await planned()
  const first = await fault(f, f.worker.execution.executionId)
  await settle(f, f.worker.execution.executionId)
  await restart(f, first.id)
  const next = await f.bind('dispatch', 'a')
  const repeated = await fault(f, next.execution.executionId)
  assert.equal(repeated.state, 'waiting')
  const task = await f.get()
  assert.equal(pending(task, 'recover').length, 0)
  assert.ok(Object.values(task.waits).some(wait => wait.kind === 'configuration' && wait.state === 'waiting'))
  await settle(f, next.execution.executionId)
  assert.equal((await restart(f, repeated.id)).code, 'RECOVERY_WAITING')
})

test('unfinished Planner restarts the same semantic action', async () => {
  const f = await fixture(), old = await f.bind('plan')
  const incident = await fault(f, old.execution.executionId)
  await settle(f, old.execution.executionId)
  assert.equal((await restart(f, incident.id)).status, 'applied')
  const next = await f.bind('plan')
  assert.equal(next.action.id, old.action.id)
  assert.equal(next.execution.generation, old.execution.generation + 1)
  assert.equal(next.execution.role, 'planner')
})

test('a committed Planner action is retained and never replayed by recovery', async () => {
  const f = await planned()
  const incident = await fault(f, f.planner.execution.executionId)
  await settle(f, f.planner.execution.executionId)
  assert.equal((await restart(f, incident.id)).status, 'applied')
  const task = await f.get()
  assert.equal(task.pendingActions[f.planner.action.id].status, 'done')
  assert.equal(pending(task, 'plan').length, 0)
  assert.equal(task.children.a.activeExecutionId, f.worker.execution.executionId)
})

test('historical Helper stays readable and must settle before original-role recovery', async () => {
  const f = await planned(), incident = await fault(f, f.worker.execution.executionId)
  const task = await f.get()
  task.incidents[incident.id].helperExecutionId = 'legacy-helper'
  task.pendingActions['legacy-help'] = { id: 'legacy-help', kind: 'help', status: 'running', payload: { goalRevision: task.goal.revision, incidentId: incident.id }, createdAt: task.createdAt, commandId: 'legacy', executionId: 'legacy-helper' }
  task.executions['legacy-helper'] = { ...f.worker.execution, executionId: 'legacy-helper', agentId: 'legacy-helper', sessionId: 'legacy-helper',
    actionId: 'legacy-help', role: 'helper', incidentId: incident.id, physicalState: 'idle' }
  task.revision++
  await f.store.putTask(task)
  assert.equal((await f.execute({ type: 'recovery.legacy' })).status, 'applied')
  await settle(f, f.worker.execution.executionId)
  assert.equal((await restart(f, incident.id)).code, 'LEGACY_OWNER_BUSY')
  await settle(f, 'legacy-helper')
  assert.equal((await restart(f, incident.id)).status, 'applied')
  const current = await f.get()
  assert.ok(current.executions['legacy-helper'])
  assert.equal(current.pendingActions['legacy-help'].status, 'superseded')
  assert.equal(pending(current, 'help').length, 0)
  assert.equal(pending(current, 'dispatch').length, 1)
})
