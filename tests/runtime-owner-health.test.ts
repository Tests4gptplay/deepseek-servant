import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, childSpec } from './task-fixture.js'
import { RuntimeCoordinator } from '../src/runtime/coordinator.js'
import { AgentSupervisor } from '../src/runtime/agent-supervisor.js'

function coordinator() { return new RuntimeCoordinator({ tasks: {} as any, supervisor: {} as any, assistants: {} as any, knowledge: {} as any, sessions: {} as any }) }
const scope = (taskId: string, token: number) => ({ taskId, executionId: taskId + '-worker', operation: 'observation' as const, token })
test('scoped runtime recovery preserves other tasks, newer faults and unrelated global failures', () => {
  const c = coordinator() as any, a = new Error('A write'), b = new Error('B write'), global = new Error('global archive')
  c.reportError(a, scope('a', 1)); c.reportError(a) // Outer catch must not promote the same scoped failure.
  c.reportError(b, scope('b', 2)); c.recoverError(scope('a', 1))
  assert.equal(c.status().status, 'degraded'); assert.match(c.status().message, /B write/)
  c.reportError(new Error('B newer write'), scope('b', 3)); c.recoverError(scope('b', 2))
  assert.match(c.status().message, /B newer write/)
  c.reportError(global); c.recoverError(scope('b', 3))
  assert.equal(c.status().message, 'global archive')
  const clean = coordinator() as any
  clean.reportError(a, scope('a', 1)); clean.reportError(a); clean.recoverError(scope('a', 1))
  assert.equal(clean.status().status, 'running')
})

async function owned() {
  const f = await fixture(), planner = await f.bind('plan')
  await f.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 0, strategy: 'Work', children: [childSpec()] }, planner.source)
  const worker = await f.bind('dispatch'), c = coordinator(), errors: unknown[] = []
  let state = 'running', disposals = 0
  const native = { actualAgent: { inbox: { nextTurn: [], nextStep: [] } }, observe: () => ({ state, jobs: [] }),
    cancel: async () => { state = 'idle' }, dispose: async () => { disposals++; state = 'stopped' }, whenIdle: () => new Promise<void>(() => {}) }
  const supervisor = new AgentSupervisor({ tasks: f.tasks, gateway: {} as any, knowledge: {} as any, defaults: {} as any, setupRole() {},
    onError: (error: unknown, attribution?: unknown) => { errors.push(error); (c.reportError as any)(error, attribution) },
    onRecovered: (attribution: unknown) => (c as any).recoverError(attribution),
  } as any)
  const owner = { taskId: 'one', executionId: worker.source.executionId, handle: native, unsubscribe() {} }
  ;(supervisor as any).owners.set(owner.executionId, owner)
  return { ...f, c, supervisor, owner, errors, state: (next: string) => { state = next }, disposals: () => disposals }
}

test('rejected observation receipt stays degraded until exact durable observation retries successfully', async () => {
  const f = await owned(), execute = f.tasks.execute.bind(f.tasks)
  f.tasks.execute = async (id, command) => command.type === 'execution.observed'
    ? { commandId: command.commandId, taskId: id, revision: 0, status: 'rejected', code: 'SYNTHETIC_REFUSAL', reason: 'write refused', actionIds: [] }
    : execute(id, command)
  await assert.rejects(f.supervisor.observeExecution(f.owner.executionId!), /SYNTHETIC_REFUSAL/)
  assert.equal(f.c.status().status, 'degraded')
  f.tasks.execute = execute
  await f.supervisor.observeExecution(f.owner.executionId!)
  assert.equal(f.c.status().status, 'running')
  assert.equal((await f.get()).executions[f.owner.executionId!].physicalState, 'running')
})

test('older observation success cannot clear a new concurrent failure', async () => {
  const f = await owned(), execute = f.tasks.execute.bind(f.tasks), first = new Error('first'), newer = new Error('newer')
  f.tasks.execute = async () => { throw first }
  await assert.rejects(f.supervisor.observeExecution(f.owner.executionId!), error => error === first)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.tasks.execute = async (id, command) => { entered.resolve(); await release.promise; return execute(id, command) }
  const oldRetry = f.supervisor.observeExecution(f.owner.executionId!)
  await entered.promise
  f.tasks.execute = async () => { throw newer }
  await assert.rejects(f.supervisor.observeExecution(f.owner.executionId!), error => error === newer)
  release.resolve(); await oldRetry
  assert.match(f.c.status().message!, /newer/)
  f.tasks.execute = execute; await f.supervisor.observeExecution(f.owner.executionId!)
  assert.equal(f.c.status().status, 'running')
})

test('running observation cannot clear failed idle settlement; same settlement retry can', async () => {
  const f = await owned(), execute = f.tasks.execute.bind(f.tasks), failure = new Error('incident write failed')
  f.state('idle')
  f.tasks.execute = async (id, command) => { if (command.type === 'incident.open') throw failure; return execute(id, command) }
  await assert.rejects((f.supervisor as any).settle(f.owner), error => error === failure)
  assert.equal(f.c.status().status, 'degraded')
  f.state('running'); f.tasks.execute = execute
  await f.supervisor.observeExecution(f.owner.executionId!)
  assert.equal(f.c.status().status, 'degraded')
  f.state('idle'); await f.supervisor.observeExecution(f.owner.executionId!)
  assert.equal(f.c.status().status, 'running')
  assert.equal(Object.values((await f.get()).incidents).length, 1)
})

test('failed retirement is not cleared by running observation and clears only after durable native release', async () => {
  const f = await owned(), failure = new Error('native close failed')
  const execute = f.tasks.execute.bind(f.tasks)
  await f.execute({ type: 'task.control', intent: 'cancel' }, { kind: 'user', id: 'owner' })
  f.state('idle')
  const dispose = f.owner.handle.dispose
  f.owner.handle.dispose = async () => { throw failure }
  await assert.rejects(f.supervisor.observeExecution(f.owner.executionId!), error => error === failure)
  f.state('running'); await f.supervisor.observeExecution(f.owner.executionId!)
  assert.match(f.c.status().message!, /native close failed/)
  f.state('idle'); f.owner.handle.dispose = dispose
  const writeFailure = new Error('stopped write failed')
  f.tasks.execute = async (id, command) => { if (command.type === 'execution.observed' && command.physicalState === 'stopped') throw writeFailure; return execute(id, command) }
  await assert.rejects(f.supervisor.observeExecution(f.owner.executionId!), error => error === writeFailure)
  assert.match(f.c.status().message!, /stopped write failed/)
  assert.equal(f.supervisor.get(f.owner.executionId!), f.owner.handle)
  f.tasks.execute = execute
  assert.equal(await f.supervisor.retireExecution(f.owner.executionId!), true)
  assert.equal((await f.get()).executions[f.owner.executionId!].physicalState, 'stopped')
  assert.equal(f.supervisor.get(f.owner.executionId!), undefined)
  assert.equal(f.c.status().status, 'running')
})

test('same Error object on distinct owners remains isolated through exact force-stop recovery', async () => {
  const f = await owned(), supervisor = f.supervisor as any, shared = new Error('shared storage failure')
  const other = { ...f.owner, taskId: 'other-task', executionId: 'other-execution' }
  supervisor.failedOwner(f.owner, 'observation', shared, 0)
  supervisor.failedOwner(other, 'settlement', shared, 0)
  assert.equal(supervisor.faults.size, 2)
  assert.equal((f.c as any).ownerFaults.size, 2)
  await f.supervisor.forceStopTasks(['one'])
  assert.equal((await f.get()).executions[f.owner.executionId!].physicalState, 'stopped')
  assert.equal(supervisor.faults.size, 1)
  assert.equal((f.c as any).ownerFaults.size, 1)
  assert.equal(f.c.status().status, 'degraded')
  assert.equal([...supervisor.faults.values()][0].scope.taskId, 'other-task')
})

test('force-stop completion cannot clear a newer owner fault raised during disposal', async () => {
  const f = await owned(), supervisor = f.supervisor as any
  supervisor.failedOwner(f.owner, 'release', new Error('old close failure'))
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), dispose = f.owner.handle.dispose
  f.owner.handle.dispose = async () => { entered.resolve(); await release.promise; await dispose() }
  const stop = f.supervisor.forceStopTasks(['one'])
  await entered.promise
  supervisor.failedOwner(f.owner, 'release', new Error('newer exact owner failure'))
  release.resolve(); await stop
  assert.match(f.c.status().message!, /newer exact owner failure/)
  assert.equal((await f.get()).executions[f.owner.executionId!].physicalState, 'stopped')
})
