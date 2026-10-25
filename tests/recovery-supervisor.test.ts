import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as tick } from 'node:timers/promises'
import { fixture, childSpec } from './task-fixture.js'
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
  listeners = new Set<() => void>()
  idleWaiters: Array<() => void> = []
  observe() { return { state: this.state === 'idle' && this.jobs.some(j => j.status !== 'completed') ? 'waiting' : this.state, jobs: this.jobs, error: this.error } }
  emit() { for (const fn of [...this.listeners]) fn() }
  idle() { this.state = 'idle'; for (const done of this.idleWaiters.splice(0)) done(); this.emit() }
  async send() { this.state = 'running'; this.emit() }
  whenIdle() { return this.state === 'running' ? new Promise<void>(done => this.idleWaiters.push(done)) : Promise.resolve() }
  async cancel() { this.idle() }
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
  return { ...f, native, supervisor, owner, flush, complete }
}

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
