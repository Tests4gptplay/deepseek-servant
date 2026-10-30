import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as tick } from 'node:timers/promises'
import { fixture, childSpec } from './task-fixture.js'
import { RuntimeCoordinator } from '../src/runtime/coordinator.js'
import { ServantApi } from '../src/application/api.js'
import { taskInput } from './support.js'
import { AgentSupervisor } from '../src/runtime/agent-supervisor.js'
import type { DshAgentGateway } from '../src/adapters/dsh/agents.js'
import type { DshAgentRequest, OwnedDshAgent } from '../src/adapters/dsh/host-types.js'
import type { KnowledgeService } from '../src/application/knowledge-service.js'

class NativeOwner {
  sessionId = ''
  actualAgent = { inbox: { nextTurn: [] as unknown[], nextStep: [] as unknown[] } }
  state: 'running' | 'idle' | 'stopped' = 'idle'
  jobs: Array<{ id: string; status: 'running' | 'stopping' | 'completed' }> = []
  error?: { message: string; turn: number; step: number }
  disposals = 0
  cancellations = 0
  sends = 0
  listeners = new Set<() => void>()
  idleWaiters: Array<() => void> = []
  observe() { return { state: this.state === 'idle' && this.jobs.some(j => j.status !== 'completed') ? 'waiting' : this.state, jobs: this.jobs, error: this.error } }
  emit() { for (const fn of [...this.listeners]) fn() }
  idle() { this.state = 'idle'; for (const done of this.idleWaiters.splice(0)) done(); this.emit() }
  async send() { this.sends++; this.state = 'running'; this.emit() }
  whenIdle() { return this.state === 'running' ? new Promise<void>(done => this.idleWaiters.push(done)) : Promise.resolve() }
  async cancel() { this.cancellations++; this.jobs.forEach(job => { job.status = 'completed' }); this.actualAgent.inbox.nextTurn.length = 0; this.actualAgent.inbox.nextStep.length = 0; this.idle() }
  async dispose() { this.disposals++; this.state = 'stopped'; for (const done of this.idleWaiters.splice(0)) done() }
  getMessages() { return [] }
  hasMessage() { return false }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
}

async function running(t: TestContext) {
  const f = await fixture(), planner = await f.bind('plan')
  await f.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 0, strategy: 'Actual work', children: [childSpec()] }, planner.source)
  const native = new NativeOwner(), errors: unknown[] = []
  const gateway = {
    exists: async () => false,
    create: async (request: DshAgentRequest) => { native.sessionId = request.sessionId; return native as unknown as OwnedDshAgent },
  } as unknown as DshAgentGateway
  const supervisor = new AgentSupervisor({ gateway, tasks: f.tasks,
    knowledge: { list: async () => [] } as unknown as KnowledgeService,
    defaults: { version: 'test', presetId: 'test', foreground: {}, background: {} },
    setupRole() {}, onError: error => errors.push(error),
  })
  t.after(async () => { await supervisor.dispose(); assert.deepEqual(errors, []) })
  const task = await f.get(), action = Object.values(task.pendingActions).find(a => a.kind === 'dispatch' && a.status === 'pending')!
  await f.execute({ type: 'action.claim', actionId: action.id, ownerId: 'test' })
  await supervisor.start(await f.get(), action)
  await f.execute({ type: 'action.finish', actionId: action.id })
  const owner = Object.values((await f.get()).executions).find(e => e.role === 'worker')!
  const source = { kind: 'agent' as const, id: owner.agentId, sessionId: owner.sessionId, executionId: owner.executionId, role: 'worker' as const }
  const flush = async () => { await tick(); await f.tasks.flush(); await tick() }
  const complete = async () => {
    const result = await f.execute({ type: 'execution.report', report: { resultId: 'finished', assignmentVersion: owner.assignmentVersion,
      outcome: 'complete', summary: 'Output saved', artifacts: [], evidence: ['Output inspected'], frontier: 'Evaluate saved output' } }, source)
    assert.equal(result.status, 'applied', JSON.stringify(result))
  }
  await flush()
  return { ...f, native, supervisor, owner, flush, complete, errors }
}

test('owner reset force-stops active Agents and Jobs, clears queued/paused task state and preserves records', { timeout: 10000 }, async t => {
  const f = await running(t)
  f.native.jobs = [{ id: 'owned-render', status: 'running' }]
  f.native.actualAgent.inbox.nextTurn.push({ id: 'queued-work' })
  await f.tasks.submit(taskInput('queued'))
  await f.tasks.submit(taskInput('paused'))
  await f.tasks.execute('paused', { type: 'task.control', intent: 'pause', commandId: 'pause', source: { kind: 'user', id: 'owner' } })
  await f.storage.set('foreground-memory/assistant/Foreground_List', { text: 'Keep index' })
  const sent = f.native.sends
  const coordinator = new RuntimeCoordinator({ tasks: f.tasks, supervisor: f.supervisor,
    assistants: {} as any, knowledge: {} as any, sessions: { inspect: async () => ({ exists: false, liveAgent: false, liveJobIds: [], jobs: [], unresolvedToolCallIds: [], queuedInbox: { nextTurn: [], nextStep: [] } }),
      probeOwnership: async () => 'free' } as any })
  t.after(() => coordinator.dispose())
  const api = new ServantApi({ coordinator: { resetTasks: () => coordinator.resetTasks('assistant') } } as any)
  const signal = new AbortController().signal
  await assert.rejects(api.call('retention', { action: 'resetTasks' }, signal))
  assert.equal(f.native.cancellations, 0)
  const result = await api.call('retention', { action: 'resetTasks', confirmation: 'force-reset-task-state' }, signal) as { resetTaskIds: string[] }
  assert.deepEqual(result.resetTaskIds.sort(), ['one', 'paused', 'queued'])
  assert.equal(f.native.cancellations, 1)
  assert.equal(f.native.disposals, 1)
  assert.equal(f.native.sends, sent, 'reset never invokes another model turn')
  assert.equal(f.supervisor.live().size, 0)
  assert.equal(f.native.jobs[0].status, 'completed')
  assert.deepEqual(f.native.actualAgent.inbox.nextTurn, [])
  assert.deepEqual(await f.tasks.list(), [])
  assert.equal((await f.tasks.history()).length, 3)
  assert.deepEqual(await f.storage.get('foreground-memory/assistant/Foreground_List'), { text: 'Keep index' })
  await coordinator.recover()
  assert.equal(f.native.sends, sent)
  assert.deepEqual((await coordinator.resetTasks('assistant')).resetTaskIds, [])
  assert.equal((await f.tasks.submit(taskInput())).code, 'TASK_RETIRED')
  assert.equal((await f.tasks.submit(taskInput('new-after-reset'))).status, 'applied')
})

test('reset catches a native launch already admitted and never sends its late prompt', { timeout: 10000 }, async t => {
  const f = await fixture(), native = new NativeOwner()
  let arrived!: () => void, release!: () => void, cancelled!: () => void
  const opening = new Promise<void>(resolve => { arrived = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const cancellation = new Promise<void>(resolve => { cancelled = resolve })
  const unsubscribe = f.tasks.subscribe(task => { if (task.control === 'cancelled') cancelled() })
  t.after(unsubscribe)
  const supervisor = new AgentSupervisor({ tasks: f.tasks, knowledge: { list: async () => [] } as any,
    defaults: { version: 'test', presetId: 'test', foreground: {}, background: {} }, setupRole() {}, onError: error => { throw error },
    gateway: { exists: async () => false, create: async (request: DshAgentRequest) => {
      native.sessionId = request.sessionId; arrived(); await gate; return native
    } } as any })
  const coordinator = new RuntimeCoordinator({ tasks: f.tasks, supervisor, assistants: {} as any, knowledge: {} as any,
    sessions: { inspect: async () => ({ exists: false, liveAgent: false, liveJobIds: [], jobs: [],
      unresolvedToolCallIds: [], queuedInbox: { nextTurn: [], nextStep: [] } }), probeOwnership: async () => 'free' } as any })
  t.after(async () => { await coordinator.dispose(); await supervisor.dispose() })
  const action = Object.values((await f.get()).pendingActions).find(action => action.kind === 'plan')!
  await f.execute({ type: 'action.claim', actionId: action.id, ownerId: 'test' })
  const launch = supervisor.start(await f.get(), action)
  ;(coordinator as any).inflight.set('one/' + action.id, launch)
  await opening
  const reset = coordinator.resetTasks('assistant')
  await cancellation
  release()
  await reset
  assert.equal(native.sends, 0)
  assert.equal(native.cancellations, 1)
  assert.equal(native.disposals, 1)
  assert.equal(supervisor.live().size, 0)
  assert.deepEqual(await f.tasks.list(), [])
  assert.equal((await f.tasks.history())[0].control, 'cancelled')
})

test('native events preserve live Jobs and queued input, then record one settled fatal error', async t => {
  const f = await running(t), id = f.owner.executionId
  f.native.emit() // Ordinary in-turn events do not replace the healthy owner.
  await f.flush()
  assert.equal(Object.keys((await f.get()).incidents).length, 0)
  f.native.error = { message: 'Native transport failed', turn: 1, step: 4 }
  f.native.jobs = [{ id: 'render', status: 'running' }]
  f.native.idle()
  await f.flush()
  assert.equal(Object.keys((await f.get()).incidents).length, 0)
  assert.equal(f.supervisor.get(id), f.native)
  f.native.jobs[0].status = 'completed'
  f.native.actualAgent.inbox.nextTurn.push({ id: 'job-result' })
  f.native.emit()
  await f.flush()
  assert.equal(f.supervisor.live().get(id)?.state, 'running')
  assert.equal(Object.keys((await f.get()).incidents).length, 0)
  assert.equal(await f.supervisor.retireExecution(id), false)
  f.native.actualAgent.inbox.nextTurn.length = 0
  f.native.emit()
  await f.flush()
  let task = await f.get()
  assert.equal(Object.keys(task.incidents).length, 1)
  assert.equal(Object.values(task.incidents)[0].errors[0].message, 'Native transport failed')
  const revision = task.revision
  f.native.emit()
  await f.flush()
  task = await f.get()
  assert.equal(task.revision, revision)
  assert.equal(f.native.disposals, 0)
  assert.equal(await f.supervisor.retireExecution(id), true)
  assert.equal(f.native.disposals, 1)
})

test('Job settlement re-arms normal release after a durable terminal report', async t => {
  const f = await running(t), id = f.owner.executionId
  f.native.jobs = [{ id: 'export', status: 'running' }]
  await f.complete()
  f.native.idle()
  await f.flush()
  assert.equal(f.supervisor.get(id), f.native)
  assert.equal(f.native.disposals, 0)
  f.native.jobs[0].status = 'completed'
  f.native.emit()
  await f.flush()
  assert.equal(f.supervisor.get(id), undefined)
  assert.equal(f.native.disposals, 1)
  const task = await f.get()
  assert.equal(task.executions[id].physicalState, 'stopped')
  assert.equal(Object.keys(task.incidents).length, 0)
  assert.equal(task.reports.finished.outcome, 'complete')
})

test('pending next-step input prevents disposal until the native queue drains', async t => {
  const f = await running(t), id = f.owner.executionId
  await f.complete()
  f.native.actualAgent.inbox.nextStep.push({ id: 'pending-native-input' })
  f.native.idle()
  await f.flush()
  assert.equal(f.native.disposals, 0)
  assert.equal(f.supervisor.live().get(id)?.state, 'running')
  f.native.actualAgent.inbox.nextStep.length = 0
  f.native.emit()
  await f.flush()
  assert.equal(f.native.disposals, 1)
  assert.equal(f.supervisor.get(id), undefined)
  assert.equal(Object.keys((await f.get()).incidents).length, 0)
})

test('existing exact supervisor owner refuses cancelled work without claiming native admission', async t => {
  const f = await running(t)
  const action = Object.values((await f.get()).pendingActions).find(a => a.kind === 'dispatch')!
  const sent = f.native.sends
  const receipt = await f.tasks.execute('one', { type: 'task.control', intent: 'cancel', commandId: 'cancel-before-readmission', source: { kind: 'user', id: 'owner' } })
  assert.equal(receipt.status, 'applied')
  assert.equal(await f.supervisor.start(await f.get(), action), false)
  assert.equal(f.native.sends, sent)
  assert.equal(f.native.disposals, 1)
  assert.equal((await f.get()).executions[f.owner.executionId].physicalState, 'stopped')
})

test('supervisor propagates native send failure instead of returning successful admission', async t => {
  const f = await running(t)
  const action = Object.values((await f.get()).pendingActions).find(a => a.kind === 'dispatch')!
  const failure = new Error('synthetic native flush failed')
  f.native.send = async () => { throw failure }
  await assert.rejects(f.supervisor.start(await f.get(), action), error => error === failure)
  assert.equal(f.native.disposals, 0)
  assert.equal(f.supervisor.get(f.owner.executionId), f.native)
})

test('ordinary resume retries a failed durable owner observation without requiring another native event', async t => {
  const f = await running(t), id = f.owner.executionId
  const planner = Object.values((await f.get()).executions).find(e => e.role === 'planner')!
  await f.execute({ type: 'execution.observed', executionId: planner.executionId, physicalState: 'stopped', ownedJobIds: [] })
  const sent = f.native.sends, errors: unknown[] = []
  const coordinator = new RuntimeCoordinator({ tasks: f.tasks, supervisor: f.supervisor,
    assistants: {} as any, knowledge: {} as any, sessions: {} as any, onError: error => errors.push(error) })
  const options = (f.supervisor as unknown as { options: import('../src/runtime/agent-supervisor.js').SupervisorOptions }).options
  const originalError = options.onError
  options.onError = (error, scope) => { originalError(error, scope); coordinator.reportError(error, scope) }
  options.onRecovered = scope => coordinator.recoverError(scope)
  // Isolate the real resume subscription from unrelated new Planner dispatch.
  // Recovery and Task storage remain real; no synthetic physical-state writes.
  ;(coordinator as unknown as { wake(): void }).wake = () => undefined
  await coordinator.start()
  await f.complete()
  const get = f.storage.get.bind(f.storage), failure = new Error('EEXIST: synthetic reversible Task record collision')
  let blocked = true
  f.storage.get = async key => { if (blocked && key === 'task:one') throw failure; return get(key) }
  f.native.idle()
  await f.flush()
  assert.ok(f.errors.some(error => error === failure))
  assert.equal(coordinator.status().status, 'degraded')
  assert.equal(f.native.disposals, 0)
  blocked = false
  const before = await f.get()
  assert.equal(before.executions[id].state, 'closed')
  assert.equal(before.executions[id].physicalState, 'running', 'failed observation did not fabricate a persisted idle/stopped state')
  assert.equal((await f.execute({ type: 'task.control', intent: 'resume' }, { kind: 'user', id: 'owner' })).status, 'applied')
  await (coordinator as unknown as { reconcileTask(taskId: string): Promise<void> }).reconcileTask('one')
  assert.ok(errors.length > 0 && errors.every(error => error === failure), 'the original storage failure remains reported, not swallowed')
  assert.equal(coordinator.status().status, 'running', 'only successful exact-owner recovery clears its active fault')
  assert.equal(f.native.disposals, 1)
  assert.equal(f.supervisor.get(id), undefined)
  assert.equal((await f.get()).executions[id].physicalState, 'stopped')
  assert.equal((await f.get()).reports.finished.outcome, 'complete')
  assert.equal(f.native.sends, sent, 'recovery observes/retires the original owner, never repeats its business input')
  f.errors.length = 0 // Original storage errors were asserted, not swallowed.
  await coordinator.dispose()
})

test('owner recovery still preserves actual running work, jobs and pending inbox despite a closed business report', async t => {
  for (const guard of ['running', 'jobs', 'inbox'] as const) {
    const f = await running(t), id = f.owner.executionId
    const planner = Object.values((await f.get()).executions).find(e => e.role === 'planner')!
    await f.execute({ type: 'execution.observed', executionId: planner.executionId, physicalState: 'stopped', ownedJobIds: [] })
    await f.complete()
    if (guard !== 'running') f.native.state = 'idle'
    if (guard === 'jobs') f.native.jobs = [{ id: 'real-owned-job', status: 'running' }]
    if (guard === 'inbox') f.native.actualAgent.inbox.nextStep.push({ id: 'pending-work' })
    const errors: unknown[] = []
    const coordinator = new RuntimeCoordinator({ tasks: f.tasks, supervisor: f.supervisor,
      assistants: {} as any, knowledge: {} as any, sessions: {} as any, onError: error => errors.push(error) })
    await coordinator.recover()
    assert.deepEqual(errors, [])
    assert.equal(f.native.disposals, 0, guard)
    assert.equal(f.supervisor.get(id), f.native)
    assert.notEqual((await f.get()).executions[id].physicalState, 'stopped')
    await coordinator.dispose()
  }
})
