import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, childSpec } from './task-fixture.js'
import { RuntimeCoordinator } from '../src/runtime/coordinator.js'

async function admitted(bind = true) {
  const f = await fixture(), planner = await f.bind('plan')
  await f.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 0, strategy: 'Work', children: [childSpec()] }, planner.source)
  const action = Object.values((await f.get()).pendingActions).find(a => a.kind === 'dispatch' && a.status === 'pending')!
  await f.execute({ type: 'action.claim', actionId: action.id, ownerId: 'test-runtime' })
  if (bind) await f.execute({ type: 'execution.bind', actionId: action.id, executionId: 'worker', agentId: 'worker', sessionId: 'worker', role: 'worker' })
  return { ...f, action }
}

test('late bound dispatch admission acknowledgement preserves the cancellation fence without revisions or events', async () => {
  const f = await admitted()
  await f.execute({ type: 'task.control', intent: 'cancel' }, { kind: 'user', id: 'owner' })
  const before = await f.get(), events: unknown[] = []
  const off = f.tasks.subscribe((...args) => events.push(args))
  const receipt = await f.execute({ type: 'action.finish', actionId: f.action.id, admission: { ownerId: 'test-runtime', executionId: 'worker' }, evidence: 'Native admission returned after cancellation' })
  off()
  assert.equal(receipt.status, 'duplicate')
  assert.deepEqual(await f.get(), before)
  assert.equal(events.length, 0)
  assert.equal(before.pendingActions[f.action.id].status, 'superseded')
  assert.equal(before.executions.worker.stopRequested, true)
})

test('unadmitted superseded dispatch and semantic action cannot be acknowledged as completed', async () => {
  const f = await fixture()
  const action = Object.values((await f.get()).pendingActions).find(a => a.kind === 'plan')!
  await f.execute({ type: 'task.control', intent: 'cancel' }, { kind: 'user', id: 'owner' })
  assert.equal((await f.execute({ type: 'action.finish', actionId: action.id })).code, 'ACTION_NOT_RUNNING')
  const g = await admitted()
  const snapshot = await g.get()
  // Pure transition regression below uses an explicitly unbound cancelled dispatch.
  const { applyTaskCommand } = await import('../src/domain/task.js')
  snapshot.pendingActions[g.action.id].status = 'superseded'
  delete snapshot.pendingActions[g.action.id].executionId
  const result = applyTaskCommand(snapshot, { type: 'action.finish', commandId: 'unbound', source: g.runtime, actionId: g.action.id }, { now: new Date().toISOString(), fingerprint: 'unbound' })
  assert.equal(result.receipt.code, 'ACTION_NOT_RUNNING')
})

test('uncertain stop settles only from exact persisted stopped/lost ownership with no jobs', async () => {
  for (const [physicalState, ownedJobIds, settles] of [
    ['stopped', [], true], ['lost', [], true], ['unknown', [], false], ['running', [], false], ['stopped', ['live-job'], false],
  ] as const) {
    const f = await admitted()
    await f.execute({ type: 'task.control', intent: 'cancel' }, { kind: 'user', id: 'owner' })
    const stop = Object.values((await f.get()).pendingActions).find(a => a.kind === 'stop' && a.payload.executionId === 'worker')!
    await f.execute({ type: 'action.claim', actionId: stop.id, ownerId: 'test-runtime' })
    await f.execute({ type: 'action.reconcile', actionId: stop.id, resolution: 'unknown', evidence: 'Native cancellation flush failed; not proof of stopped state' })
    await f.execute({ type: 'execution.observed', executionId: 'worker', physicalState, ownedJobIds: [...ownedJobIds] })
    const errors: unknown[] = []
    // Preserve records for inspection, without bypassing the real Task command journal.
    f.tasks.cleanupCompleted = async () => false
    const coordinator = new RuntimeCoordinator({ tasks: f.tasks, supervisor: { live: () => new Map() } as any,
      assistants: {} as any, knowledge: {} as any, sessions: {} as any, onError: error => errors.push(error) })
    // Test the existing event-driven settlement pass deterministically, not a timer or Host poll.
    await (coordinator as unknown as { drain(): Promise<void> }).drain()
    const task = await f.get()
    assert.equal(task.pendingActions[stop.id].status, settles ? 'done' : 'uncertain')
    assert.equal(task.waits['uncertain:' + stop.id].state, settles ? 'resolved' : 'waiting')
    assert.deepEqual(errors, [])
    await coordinator.dispose()
  }
})

test('late admission ACK rejects wrong actor, claim owner and execution; repeated valid ACK is inert after revision', async () => {
  const f = await admitted(), original = await f.get()
  await f.execute({ type: 'task.reviseGoal', expectedGoalRevision: 1, goal: { ...original.goal, objective: 'Revised objective' } }, { kind: 'user', id: 'owner' })
  const cmd = { type: 'action.finish' as const, actionId: f.action.id, admission: { ownerId: 'test-runtime', executionId: 'worker' } }
  assert.equal((await f.execute(cmd, { kind: 'user', id: 'owner' })).code, 'RUNTIME_ONLY')
  assert.equal((await f.execute({ ...cmd, admission: { ownerId: 'other-runtime', executionId: 'worker' } })).code, 'ADMISSION_OWNER_MISMATCH')
  assert.equal((await f.execute({ ...cmd, admission: { ownerId: 'test-runtime', executionId: 'other-execution' } })).code, 'ADMISSION_BINDING_MISMATCH')
  assert.equal((await f.execute({ type: 'action.finish', actionId: f.action.id })).code, 'ACTION_NOT_RUNNING')
  const before = await f.get(), events: unknown[] = []
  const off = f.tasks.subscribe((...args) => events.push(args))
  for (let i = 0; i < 2; i++) assert.equal((await f.execute(cmd)).status, 'duplicate')
  off()
  assert.deepEqual(await f.get(), before)
  assert.equal(events.length, 0)
  assert.equal(before.goal.revision, 2)
})

test('late continuation ACK requires its own claimed action and exact existing Worker', async () => {
  const f = await admitted()
  await f.execute({ type: 'action.finish', actionId: f.action.id })
  const worker = (await f.get()).executions.worker
  await f.execute({ type: 'execution.report', report: { resultId: 'progress', assignmentVersion: worker.assignmentVersion,
    outcome: 'continue', summary: 'Bounded progress', frontier: 'Continue', artifacts: [], evidence: [] } },
    { kind: 'agent', id: 'worker', sessionId: 'worker', executionId: 'worker', role: 'worker' })
  const action = Object.values((await f.get()).pendingActions).find(a => a.kind === 'continue' && a.status === 'pending')!
  assert.ok(action)
  assert.equal((await f.execute({ type: 'action.claim', actionId: action.id, ownerId: 'continuation-runtime' })).status, 'applied')
  await f.execute({ type: 'task.control', intent: 'cancel' }, { kind: 'user', id: 'owner' })
  const before = await f.get()
  assert.equal((await f.execute({ type: 'action.finish', actionId: action.id, admission: { ownerId: 'test-runtime', executionId: 'worker' } })).code, 'ADMISSION_OWNER_MISMATCH')
  const afterRejected = await f.get()
  assert.equal((await f.execute({ type: 'action.finish', actionId: action.id, admission: { ownerId: 'continuation-runtime', executionId: 'worker' } })).status, 'duplicate')
  assert.deepEqual(await f.get(), afterRejected)
  assert.equal(before.pendingActions[action.id].status, 'superseded')
})

test('coordinator late cancellation acknowledges only successful admission, not refused or failed native start', async () => {
  for (const outcome of ['admitted', 'cancelled-before-send', 'flush-failed'] as const) {
    const f = await admitted(false), failure = new Error('Original admission flush failed'), commands: string[] = []
    const execute = f.tasks.execute.bind(f.tasks)
    f.tasks.execute = async (taskId, command) => { commands.push(command.type); return execute(taskId, command) }
    const coordinator = new RuntimeCoordinator({ tasks: f.tasks, supervisor: {
      live: () => new Map(), start: async () => {
        await f.execute({ type: 'execution.bind', actionId: f.action.id, executionId: 'worker', agentId: 'worker', sessionId: 'worker', role: 'worker' })
        await f.execute({ type: 'task.control', intent: 'cancel' }, { kind: 'user', id: 'owner' })
        if (outcome === 'flush-failed') throw failure
        return outcome === 'admitted'
      },
    } as any, assistants: {} as any, knowledge: {} as any, sessions: {} as any })
    const runtime = coordinator as unknown as { ownerId: string; run(taskId: string, actionId: string, attemptId: string): Promise<void> }
    runtime.ownerId = 'test-runtime'
    if (outcome === 'flush-failed') await assert.rejects(runtime.run('one', f.action.id, 'attempt'), error => error === failure)
    else await runtime.run('one', f.action.id, 'attempt')
    assert.equal((await f.get()).pendingActions[f.action.id].status, 'superseded')
    assert.equal(commands.filter(type => type === 'action.finish').length, outcome === 'admitted' ? 1 : 0, 'only successful admission emits an ACK; refused/failed admission never calls finish')
    await coordinator.dispose()
  }
})

test('admission acknowledgement command identity includes the runtime binding across restart', async () => {
  const f = await admitted()
  const coordinator = new RuntimeCoordinator({ tasks: f.tasks, supervisor: {} as any, assistants: {} as any, knowledge: {} as any, sessions: {} as any })
  const runtime = coordinator as unknown as { ownerId: string; finish(taskId: string, action: typeof f.action, evidence: string): Promise<void> }
  runtime.ownerId = 'test-runtime'
  await runtime.finish('one', f.action, 'Same durable native admission evidence')
  const before = await f.get()
  runtime.ownerId = 'new-runtime-after-restart'
  await runtime.finish('one', f.action, 'Same durable native admission evidence')
  assert.deepEqual(await f.get(), before, 'already done is inert, not COMMAND_ID_REUSED for the new runtime proof')
  await coordinator.dispose()
})

test('stop acknowledgement keeps its original command identity and never carries admission proof', async () => {
  const f = await admitted()
  await f.execute({ type: 'task.control', intent: 'cancel' }, { kind: 'user', id: 'owner' })
  const stop = Object.values((await f.get()).pendingActions).find(a => a.kind === 'stop' && a.payload.executionId === 'worker')!
  await f.execute({ type: 'action.claim', actionId: stop.id, ownerId: 'test-runtime' })
  await f.execute({ type: 'execution.observed', executionId: 'worker', physicalState: 'stopped', ownedJobIds: [] })
  const seen: any[] = [], off = f.tasks.subscribe((_task, _receipt, command) => { if (command?.type === 'action.finish') seen.push(command) })
  const coordinator = new RuntimeCoordinator({ tasks: f.tasks, supervisor: {} as any, assistants: {} as any, knowledge: {} as any, sessions: {} as any })
  const evidence = 'Native owner is stopped without jobs'
  await (coordinator as unknown as { finish(taskId: string, action: typeof stop, evidence: string): Promise<void> }).finish('one', stop, evidence)
  const { createHash } = await import('node:crypto')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].admission, undefined)
  assert.equal(seen[0].commandId, `finish:${stop.id}:${createHash('sha256').update(evidence).digest('hex').slice(0, 12)}`)
  off(); await coordinator.dispose()
})
