import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentSupervisor } from '../src/runtime/agent-supervisor.js'
import { QueryService } from '../src/application/query-service.js'
import { AssistantService } from '../src/application/assistant-service.js'
import { installRoleTools } from '../src/roles/tools.js'
import { MemoryStorage } from './support.js'
import { childSpec, fixture } from './task-fixture.js'

test('supervisor releases remaining owners when one foreground disposal fails', async () => {
  const supervisor = new AgentSupervisor({} as any)
  const foreground = (supervisor as any).foreground as Map<string, any>
  let released = false
  foreground.set('broken', { dispose: async () => { throw new Error('Close failed') } })
  foreground.set('healthy', { dispose: async () => { await new Promise(resolve => setTimeout(resolve, 5)); released = true } })
  await assert.rejects(supervisor.dispose(), AggregateError)
  assert.equal(released, true)
  assert.equal(foreground.size, 0)
})

test('missing persisted map records are reported instead of silently becoming empty', async () => {
  const f = await fixture()
  const before = await f.get()
  assert.ok(Object.keys(before.receipts).length > 0)
  const rows = await f.storage.list<any>('execution/one/')
  for (const row of rows) {
    if (row.value?.metadata?.field === 'receipts') await f.storage.delete(row.key)
  }
  await assert.rejects(f.get(), /incomplete.*receipts/i)
  assert.equal((await f.store.listTasks()).length, 0)
  assert.match(f.store.problems.get('one') ?? '', /receipts/)
})

test('one failed view section preserves other sections and exposes its error', async () => {
  const f = await fixture(), task = await f.get()
  for (const failed of ['tasks', 'history', 'messages', 'knowledge']) {
    const read = async (name: string, value: any) => {
      if (failed === name) throw new Error(name + ' record is damaged')
      return value
    }
    const query = new QueryService({
      assistants: { get: async () => ({ id: 'default', revision: 1, sessionId: 'session', settings: {}, workspace: { id: 'workspace' }, inputs: {} }),
        conversationPage: () => read('messages', { messages: [{ id: 'message' }] }) },
      tasks: { list: () => read('tasks', [{ ...task, assistantId: 'default' }]), history: () => read('history', []), store: { problems: new Map() } },
      knowledge: { list: () => read('knowledge', [{ id: 'knowledge' }]) },
      workspaces: () => [], runtime: () => ({ status: 'running', workerSeats: 2 }), runtimeSettings: () => ({ workerSeats: 2 }),
      recordStorage: () => ({ directory: process.cwd() }),
    } as any)
    const view = await query.view()
    assert.equal(view.tasks.length, failed === 'tasks' ? 0 : 1)
    assert.equal(view.messages.length, failed === 'messages' ? 0 : 1)
    assert.equal(view.knowledge.length, failed === 'knowledge' ? 0 : 1)
    assert.ok(view.recordStorage.issues?.some(issue => issue.includes(failed + ' record is damaged')))
  }
})

test('foreground registered tools survive supervisor restrictions and execution guard', async t => {
  const store = new MemoryStorage()
  const assistants = new AssistantService({ store, defaults: { name: 'Servant', presetId: 'standard', foreground: {}, background: {} },
    runtime: {} as any, resolveWorkspace: async () => ({ id: 'workspace', directory: process.cwd() }) })
  const definitions = new Map<string, any>(), denied = new Set<string>(), hooks = new Map<string, any>()
  const agent = { id: 'foreground', session: { snapshotEvents: () => [] } } as any
  const ctx = { systemPrompt: { section() {} }, tools: {
    register: (tool: any) => definitions.set(tool.name, tool),
    schemas: () => [...definitions.values()].filter(tool => !denied.has(tool.name)),
    restrict: ({ deny }: { deny: string[] }) => deny.forEach(name => denied.add(name)),
  }, get: () => ({ registerProvider: () => () => {} }), on: (event: string, callback: any) => { hooks.set(event, callback); return () => {} }, effect() {} } as any
  const supervisor = new AgentSupervisor({
    gateway: { exists: async () => false, create: async (request: any) => {
      await request.setup(ctx, agent)
      return { sessionId: request.sessionId, subscribe: () => () => {}, dispose: async () => {} }
    } } as any,
    tasks: {} as any, knowledge: { subscribe: () => () => {} } as any,
    defaults: { version: 'test', presetId: 'standard', foreground: {}, background: {} },
    setupRole: (scope, owner, binding) => installRoleTools(scope, owner, binding, { assistants } as any),
    onError: error => { throw error },
  })
  t.after(() => supervisor.dispose())
  await supervisor.ensureForeground({ id: 'default', sessionId: 'foreground-session', workspace: { id: 'workspace', directory: process.cwd() },
    settings: { foreground: {}, presetId: 'standard' } } as any)
  for (const name of definitions.keys()) {
    assert.ok(!denied.has(name), name + ' is hidden by supervisor')
    const result = await hooks.get('tools/pre-execute')({ agent, name }, async () => 'allowed')
    assert.equal(result, 'allowed', name + ' is rejected by execution guard')
  }
  const exec = { agent, signal: new AbortController().signal, callId: 'memory' }
  const memory = definitions.get('foreground_memory')
  await memory.execute({ action: 'replace', document: 'Foreground_List', text: 'Current assignment' }, exec)
  assert.equal((await memory.execute({ action: 'read', document: 'Foreground_List' }, exec)).text, 'Current assignment')
})

test('goal revision during accepted delivery leaves the existing delivery runnable', async () => {
  const f = await fixture(), planner = await f.bind('plan')
  await f.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 0, strategy: 'Deliver result', children: [childSpec()] }, planner.source)
  const worker = await f.bind('dispatch')
  await f.execute({ type: 'execution.report', report: { resultId: 'done', assignmentVersion: 1, outcome: 'complete',
    summary: 'Saved result', artifacts: [], evidence: ['Result inspected'], frontier: 'Review' } }, worker.source)
  const evaluator = await f.bind('evaluate')
  assert.equal((await f.execute({ type: 'planning.decide', expectedGoalRevision: 1, summary: 'Accepted',
    decisions: [{ childId: 'a', resultId: 'done', outcome: 'accept', reason: 'Matches request' }],
    deliver: { id: 'delivery', summary: 'Finished', artifacts: [] } }, evaluator.source)).status, 'applied')
  const before = await f.get()
  const revised = await f.execute({ type: 'task.reviseGoal', expectedGoalRevision: 1,
    goal: { ...before.goal, objective: 'Different goal' } }, { kind: 'user', id: 'owner' })
  assert.equal(revised.code, 'TASK_DELIVERING')
  const task = await f.get()
  assert.deepEqual(task.goal, before.goal)
  const delivery = Object.values(task.pendingActions).find(action => action.kind === 'deliver')!
  assert.equal((await f.execute({ type: 'action.claim', actionId: delivery.id, ownerId: 'runtime' })).status, 'applied')
  assert.equal((await f.execute({ type: 'action.finish', actionId: delivery.id, notificationId: 'delivered' })).status, 'applied')
  assert.equal((await f.get()).phase, 'completed')
})

test('resource waits accept an explicit user resolution and resume the existing work', async () => {
  const f = await fixture(), planner = await f.bind('plan')
  await f.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 0, strategy: 'Use supplied asset', children: [childSpec()] }, planner.source)
  const worker = await f.bind('dispatch')
  assert.equal((await f.execute({ type: 'execution.report', report: { resultId: 'await-resource', assignmentVersion: 1, outcome: 'wait',
    summary: 'Need source asset', artifacts: [], evidence: [], frontier: 'Read supplied asset',
    wait: { id: 'asset', kind: 'resource', reason: 'Missing source', condition: 'Asset supplied', resume: 'worker' } } }, worker.source)).status, 'applied')
  assert.equal((await f.execute({ type: 'wait.answer', waitId: 'asset', answer: 'Source asset is available in the workspace' }, { kind: 'user', id: 'owner' })).status, 'applied')
  const task = await f.get()
  assert.equal(task.waits.asset.state, 'resolved')
  assert.ok(Object.values(task.pendingActions).some(action => action.kind === 'continue' && action.status === 'pending'))
})
