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
    lifecycleKnown: true, eventCount: 15, queuedInbox: { nextTurn: [], nextStep: [] }, unresolvedToolCallIds: [], jobs: [],
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

test('cold recovery retains unmatched Job ownership rather than replaying native effects', async () => {
  const f = await coldFixture()
  await f.execute({ type: 'execution.observed', executionId: f.worker.execution.executionId, physicalState: 'running', ownedJobIds: ['unmatched-job'] })
  await f.recover()
  const task = await f.get(), old = task.executions[f.worker.execution.executionId]
  assert.equal(old.physicalState, 'unknown')
  assert.deepEqual(old.ownedJobIds, ['unmatched-job'])
  assert.deepEqual(f.restored, [])
  const recovery = Object.values(task.pendingActions).find(a => a.kind === 'recover' && a.status === 'pending')!
  assert.ok(recovery)
  assert.equal(new Scheduler().canRun(task, recovery, [task], new Map()).allowed, false)
  assert.equal(task.children.a.activeExecutionId, old.executionId)
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
