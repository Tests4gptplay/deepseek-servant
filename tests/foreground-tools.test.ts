import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { installRoleTools, type RoleToolsOptions } from '../src/roles/tools.js'
import { fixture } from './task-fixture.js'
import { Scheduler } from '../src/runtime/scheduler.js'

const event = (type: string, data: unknown) => ({ type, data, seq: 0, time: Date.now(), surfaceOp: 'append' }) as SessionEvent
const user = (id: string, text: string, kind = 'user', messageId?: string) => event('user/message', {
  id, role: 'user', source: { kind, ...(messageId ? { messageId } : {}) }, content: [{ type: 'text', text }],
})
function toolsFor(events: SessionEvent[], options: RoleToolsOptions) {
  const definitions = new Map<string, { execute(input: unknown, exec: unknown): Promise<any> }>()
  const agent = { id: 'foreground', session: { snapshotEvents: () => events } } as unknown as Agent
  const ctx = { systemPrompt: { section() {} }, tools: { register: (definition: { name: string; execute(input: unknown, exec: unknown): Promise<any> }) => definitions.set(definition.name, definition) } } as unknown as Context
  installRoleTools(ctx, agent, { assistantId: 'assistant', sessionId: 'foreground', role: 'foreground' }, options)
  return (name: string, input: unknown) => definitions.get(name)!.execute(input, { agent, signal: new AbortController().signal, callId: 'call' })
}

test('foreground memory keeps object parameters and validates replacement text before writing', async () => {
  const writes: unknown[][] = []
  const call = toolsFor([], { assistants: { foregroundMemory: async (...args: unknown[]) => { writes.push(args); return { body: args[2] ?? 'saved' } } } } as unknown as RoleToolsOptions)
  await call('foreground_memory', { action: 'read', document: 'Foreground_List' })
  await call('foreground_memory', { action: 'replace', document: 'Foreground_Cache', text: 'remember this' })
  await call('foreground_memory', { action: 'clear', document: 'Foreground_Cache' })
  await assert.rejects(call('foreground_memory', { action: 'replace', document: 'Foreground_List' }), /Replacement text is required/)
  assert.deepEqual(writes, [['assistant', 'Foreground_List', undefined], ['assistant', 'Foreground_Cache', 'remember this'], ['assistant', 'Foreground_Cache', '']])
})

test('a resumed foreground intent binds the original user identity and keeps task submission idempotent', async () => {
  const submitted: any[] = []
  const call = toolsFor([event('turn/start', { turn: 1 }), user('original', 'Original request'),
    event('turn/end', { turn: 1, reason: { kind: 'interrupted' } }), event('turn/start', { turn: 2 }),
    user('resume', 'Continue', 'deepseek-servant-resume', 'original')], {
    tasks: { submit: async input => { submitted.push(input); return { status: 'applied' } } },
    assistants: { get: async () => ({ workspace: { id: 'workspace', directory: 'test' }, inputs: {}, settings: { presetId: 'standard', foreground: {}, background: {} } }) },
  } as unknown as RoleToolsOptions)
  await call('task_submit', { goal: { objective: 'Finish', constraints: [], deliverables: ['result.txt'], acceptanceCriteria: ['Complete result'] } })
  assert.equal(submitted[0].commandId, 'submit:foreground:original:main')
  assert.equal(submitted[0].source.messageId, 'original')
  assert.equal(submitted[0].goal.request, 'Original request')
})

test('the actual conversational answer resolves its question and admits current-goal planning', async () => {
  const f = await fixture(), planner = await f.bind('plan')
  assert.equal((await f.execute({ type: 'execution.requestHelp', kind: 'user', operation: 'Choose output', message: 'Need output format',
    wait: { id: 'question', kind: 'user', reason: 'Output format', question: 'Use Markdown?', condition: 'User chooses', resume: 'Plan requested output' } }, planner.source)).status, 'applied')
  await f.execute({ type: 'execution.observed', executionId: planner.execution.executionId, physicalState: 'stopped', ownedJobIds: [] })
  const text = 'Use Markdown. Continue without another confirmation.'
  const call = toolsFor([event('turn/start', { turn: 1 }), user('answer', text)], { tasks: f.tasks } as RoleToolsOptions)
  assert.equal((await call('task_answer', { taskId: 'one', waitId: 'question' })).status, 'applied')
  const task = await f.get()
  assert.equal(task.waits.question.answer, text)
  assert.equal(task.waits.question.state, 'resolved')
  const plan = Object.values(task.pendingActions).find(a => a.kind === 'plan' && a.status === 'pending')!
  assert.equal(new Scheduler().canRun(task, plan, [task]).allowed, true)
})

test('foreground task discovery pages beyond the first fifty tasks', async () => {
  const f = await fixture(), sample = await f.get()
  const tasks = Array.from({ length: 57 }, (_, index) => ({ ...sample, id: 'task-' + index }))
  const call = toolsFor([], { tasks: { list: async () => tasks } } as unknown as RoleToolsOptions)
  const first = await call('task_query', {})
  assert.equal(first.tasks.length, 50)
  assert.equal(first.total, 57)
  const rest = await call('task_query', { cursor: first.nextCursor })
  assert.equal(rest.tasks.length, 7)
  assert.equal(rest.nextCursor, undefined)
})

test('background notifications cannot supply user answers from prior conversation', async () => {
  const call = toolsFor([event('turn/start', { turn: 1 }), user('old', 'Earlier request'), event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    event('turn/start', { turn: 2 }), user('notification', 'Task finished', 'deepseek-servant')], {} as RoleToolsOptions)
  await assert.rejects(call('task_answer', { taskId: 'one', waitId: 'question' }), /no matching user input/)
})
