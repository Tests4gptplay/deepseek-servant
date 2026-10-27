import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, childSpec } from './task-fixture.js'
import { RuntimeCoordinator, type CoordinatorOptions } from '../src/runtime/coordinator.js'
import { Scheduler } from '../src/runtime/scheduler.js'
import type { DshSessionInspection } from '../src/adapters/dsh/sessions.js'

async function coldFixture() {
  const f = await fixture(), planner = await f.bind('plan')
  await f.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 0, strategy: 'Preserve work', children: [childSpec()] }, planner.source)
  const worker = await f.bind('dispatch', 'a')
  await f.execute({ type: 'execution.observed', executionId: planner.execution.executionId, physicalState: 'stopped', ownedJobIds: [] })
  const inspection: DshSessionInspection = { exists: true, sessionId: worker.execution.sessionId, liveAgent: false, liveSession: false,
    lifecycleKnown: true, liveJobIds: [], eventCount: 15, queuedInbox: { nextTurn: [], nextStep: [] }, unresolvedToolCallIds: [], jobs: [],
    lastTurn: { turn: 1, closed: true, reason: 'completed', toolCallIds: ['saved-report'] } }
  const restored: string[] = [], seen: string[] = [], errors: unknown[] = []
  let inputPresent = false
  const coordinator = new RuntimeCoordinator({
    tasks: f.tasks,
    assistants: {} as CoordinatorOptions['assistants'], knowledge: {} as CoordinatorOptions['knowledge'],
    supervisor: { get: (id: string) => restored.includes(id) ? {} : undefined,
      restoreIdle: async (_task: unknown, execution: { executionId: string }) => { restored.push(execution.executionId) },
      live: () => new Map(),
    } as unknown as CoordinatorOptions['supervisor'],
    sessions: { inspect: async () => inspection, probeOwnership: async () => 'free',
      hasMessage: async (_session: string, input: string) => { seen.push(input); return inputPresent },
    } as unknown as CoordinatorOptions['sessions'],
    onError: error => errors.push(error),
  })
  const report = async (outcome: 'continue' | 'complete') => {
    assert.equal((await f.execute({ type: 'execution.report', report: { resultId: 'saved', assignmentVersion: 1, outcome,
      summary: 'Durable work', artifacts: [], evidence: ['Actual saved output'], frontier: 'Next concrete action' } }, worker.source,
      'tool:' + worker.execution.sessionId + ':saved-report')).status, 'applied')
  }
  const recover = async () => { await coordinator.recover(); assert.deepEqual(errors, []) }
  return { ...f, worker, inspection, restored, seen, report, recover, admitInput: () => { inputPresent = true } }
}

test('one unreadable task does not prevent recovery of the remaining tasks', async () => {
  const visited: string[] = [], errors: unknown[] = []
  const rows = ['broken', 'healthy'].map(id => ({ id, pendingActions: {}, executions: {} }))
  const coordinator = new RuntimeCoordinator({
    tasks: { list: async () => rows, get: async (id: string) => {
      visited.push(id)
      if (id === 'broken') throw new Error('Broken task record')
      return rows[1]
    } } as any,
    assistants: {} as any, knowledge: {} as any, supervisor: {} as any, sessions: {} as any,
    onError: error => errors.push(error),
  })
  await coordinator.recover()
  assert.ok(visited.includes('healthy'))
  assert.equal(errors.length, 1)
  assert.match(coordinator.status().message ?? '', /Broken task record/)
})

test('cold recovery restores the exact reported idle owner and reconciles admitted continuation ID', async () => {
  const f = await coldFixture()
  await f.report('continue')
  const continuation = Object.values((await f.get()).pendingActions).find(a => a.kind === 'continue' && a.status === 'pending')!
  await f.execute({ type: 'action.claim', actionId: continuation.id, ownerId: 'old-runtime' })
  f.admitInput()
  await f.recover()
  const task = await f.get()
  assert.deepEqual(f.restored, [f.worker.execution.executionId])
  assert.deepEqual(f.seen, ['servant-action-' + continuation.id])
  assert.equal(task.pendingActions[continuation.id].status, 'done')
  assert.equal(task.children.a.activeExecutionId, f.worker.execution.executionId)
  assert.equal(Object.keys(task.incidents).length, 0)
  assert.equal(Object.values(task.executions).filter(e => e.role === 'worker').length, 1)
})

test('power-loss recovery preserves interrupted tool/job facts and automatically admits the same-role successor', async () => {
  const f = await coldFixture()
  await f.execute({ type: 'execution.observed', executionId: f.worker.execution.executionId, physicalState: 'running', ownedJobIds: ['unmatched-job'] })
  f.inspection.unresolvedToolCallIds = ['unfinished-call']
  f.inspection.jobs = [{ id: 'unmatched-job', owner: f.worker.execution.agentId, kind: 'external-operation', state: 'registered' }]
  f.inspection.lastTurn!.closed = false
  await f.recover()
  const task = await f.get(), old = task.executions[f.worker.execution.executionId]
  assert.equal(old.physicalState, 'lost')
  assert.deepEqual(old.ownedJobIds, [])
  assert.deepEqual(f.restored, [])
  const recovery = Object.values(task.pendingActions).find(a => a.kind === 'recover' && a.status === 'pending')!
  assert.equal(new Scheduler().canRun(task, recovery, [task], new Map()).allowed, true)
  const incident = task.incidents[recovery.payload.incidentId!]!
  assert.deepEqual(incident.interruption?.recordedJobIds, ['unmatched-job'])
  assert.deepEqual(incident.interruption?.pendingToolCallIds, ['unfinished-call'])
  assert.equal(incident.interruption?.sessionId, old.sessionId)
  await f.execute({ type: 'recovery.restart', incidentId: incident.id, evidence: 'Native owner absent; resume with retained interruption evidence.' })
  const next = await f.bind('dispatch', 'a')
  assert.equal(next.execution.assignmentVersion, old.assignmentVersion)
  assert.equal(next.execution.generation, 2)
  assert.equal((await f.get()).children.a.progressSegments, 0)
})

test('repeated host interruptions at the same frontier keep automatic recovery, without a configuration handshake', async () => {
  const f = await coldFixture()
  f.inspection.lastTurn!.closed = false
  for (let generation = 1; generation <= 3; generation++) {
    await f.recover()
    const task = await f.get()
    const recovery = Object.values(task.pendingActions).find(a => a.kind === 'recover' && a.status === 'pending')!
    assert.ok(recovery)
    assert.equal(new Scheduler().canRun(task, recovery, [task]).allowed, true)
    assert.equal(Object.values(task.waits).some(wait => wait.kind === 'configuration' && wait.state === 'waiting'), false)
    await f.execute({ type: 'recovery.restart', incidentId: recovery.payload.incidentId!, evidence: 'Cold native owner is absent.' })
    const next = await f.bind('dispatch', 'a')
    assert.equal(next.execution.assignmentVersion, 1)
    assert.equal(next.execution.generation, generation + 1)
    assert.equal((await f.get()).children.a.progressSegments, 0)
  }
})

test('cold reconciliation preserves explicit user pause and cancellation', async () => {
  for (const intent of ['pause', 'cancel'] as const) {
    const f = await coldFixture()
    assert.equal((await f.execute({ type: 'task.control', intent }, { kind: 'user', id: 'owner' })).status, 'applied')
    await f.recover()
    const task = await f.get()
    for (const action of Object.values(task.pendingActions).filter(action => action.status === 'pending' && action.kind !== 'stop'))
      assert.equal(new Scheduler().canRun(task, action, [task]).allowed, false)
    assert.equal(task.control, intent === 'pause' ? 'paused' : 'cancelled')
    if (intent === 'cancel') {
      assert.equal(task.executions[f.worker.execution.executionId].state, 'closed')
      assert.equal(task.children.a.status, 'cancelled')
      assert.equal(task.children.a.activeExecutionId, undefined)
      assert.equal(Object.values(task.pendingActions).some(action => action.kind === 'recover' && action.status === 'pending'), false)
    }
  }
})

test('cold recovery retains an actually live native Job instead of admitting a second owner', async () => {
  const f = await coldFixture()
  await f.execute({ type: 'execution.observed', executionId: f.worker.execution.executionId, physicalState: 'running', ownedJobIds: ['live-job'] })
  f.inspection.liveJobIds = ['live-job']
  await f.recover()
  const task = await f.get()
  assert.equal(task.executions[f.worker.execution.executionId].physicalState, 'unknown')
  const recovery = Object.values(task.pendingActions).find(a => a.kind === 'recover' && a.status === 'pending')!
  assert.equal(new Scheduler().canRun(task, recovery, [task], new Map()).allowed, false)
})

test('cold recovery recognizes a saved terminal result without creating a replacement Worker', async () => {
  const f = await coldFixture()
  await f.report('complete')
  await f.recover()
  const task = await f.get()
  assert.equal(task.executions[f.worker.execution.executionId].physicalState, 'lost')
  assert.equal(task.children.a.currentResultId, 'saved')
  assert.equal(Object.keys(task.incidents).length, 0)
  assert.deepEqual(f.restored, [])
  const actions = Object.values(task.pendingActions).filter(a => a.status === 'pending')
  assert.equal(actions.filter(a => a.kind === 'dispatch').length, 0)
  assert.deepEqual(actions.filter(a => a.kind === 'evaluate').map(a => a.payload.resultIds), [['saved']])
})
