import assert from 'node:assert/strict'
import { ServantStore } from '../src/application/servant-store.js'
import { TaskService } from '../src/application/task-service.js'
import type { ActionKind, ChildSpec, CommandSource, TaskCommand } from '../src/contracts/task.js'
import { MemoryStorage, taskInput } from './support.js'

export const childSpec = (id = 'a', dependsOn: string[] = []): ChildSpec => ({
  id, title: id, objective: 'Produce ' + id, acceptanceCriteria: ['Accepted evidence'],
  inputArtifacts: [], dependsOn, writeScopes: [id], resources: [],
})
export async function fixture(request?: string) {
  const storage = new MemoryStorage(), store = new ServantStore(storage), tasks = new TaskService(store)
  const input = taskInput()
  if (request) input.goal.request = request
  assert.equal((await tasks.submit(input)).status, 'applied')
  let number = 0
  const runtime = { kind: 'runtime' as const, id: 'test-runtime' }
  const get = async () => (await tasks.get('one'))!
  const execute = (command: Omit<TaskCommand, 'commandId' | 'source'> & Record<string, unknown>, source: CommandSource = runtime, commandId = 'cmd-' + ++number) =>
    tasks.execute('one', { ...command, source, commandId } as TaskCommand)
  async function bind(kind: ActionKind, childId?: string) {
    const action = Object.values((await get()).pendingActions).find(a => a.kind === kind && a.status === 'pending' && (!childId || a.payload.childId === childId))!
    assert.ok(action, 'Pending ' + kind + ' action')
    assert.equal((await execute({ type: 'action.claim', actionId: action.id, ownerId: 'runtime' })).status, 'applied')
    const id = 'owner-' + ++number, role = kind === 'dispatch' ? 'worker' : 'planner'
    assert.equal((await execute({ type: 'execution.bind', actionId: action.id, executionId: id, agentId: id, sessionId: id, role })).status, 'applied')
    if (kind === 'dispatch') assert.equal((await execute({ type: 'action.finish', actionId: action.id })).status, 'applied')
    const source = { kind: 'agent' as const, id, sessionId: id, executionId: id, role } as const
    return { source, execution: (await get()).executions[id], action: (await get()).pendingActions[action.id] }
  }
  return { storage, store, tasks, get, execute, bind, runtime }
}
