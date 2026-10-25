import test from 'node:test'
import assert from 'node:assert/strict'
import { TaskRecordAccess, type RecordCaller } from '../src/application/task-record-access.js'
import { GoalSchema, MemorySchema, ReportSchema } from '../src/contracts/schemas.js'
import { assembleRoleInput, memoryRef, queryTaskMemory, type TaskMemoryQuery } from '../src/runtime/context-assembler.js'
import { fixture, childSpec } from './task-fixture.js'

test('T02/T03: durable schemas accept full text and more than 100 items', async () => {
  const text = '完整原文🙂'.repeat(100_000)
  const f = await fixture(text), task = await f.get()
  const { revision: _revision, ...goal } = task.goal
  assert.equal(GoalSchema.parse(goal).request, text)
  assert.equal(MemorySchema.parse({ planNote: { expectedRevision: 0, body: text, frontier: text, changeSummary: text,
    backlog: Array.from({ length: 121 }, (_, i) => ({ id: 'later-' + i, objective: text.slice(0, 20), reason: 'dependency', dependsOn: [], trigger: 'ready', required: true, status: 'pending' })) } }).planNote!.backlog!.length, 121)
  assert.equal(ReportSchema.parse({ resultId: 'r', assignmentVersion: 1, outcome: 'progress', summary: text,
    artifacts: [], evidence: Array.from({ length: 121 }, () => text.slice(0, 20)), frontier: text }).summary, text)
})

test('T05/T06: versioned full note, bounded hot context, owner-scoped exact record reads', async () => {
  const text = '完整原文🙂'.repeat(100_000)
  const f = await fixture(text), planner = await f.bind('plan')
  const caller: RecordCaller = { assistantId: 'assistant', taskId: 'one', role: 'planner',
    executionId: planner.execution.executionId, agentId: planner.source.id, sessionId: planner.source.sessionId }
  const access = new TaskRecordAccess(f.tasks, caller)
  const record = await access.append('planner-memory', text, 'raw-note')
  assert.equal((await access.append('planner-memory', text, 'raw-note')).ref, record.ref)
  await assert.rejects(access.append('planner-memory', 'changed', 'raw-note'), /COMMAND_ID_REUSED/)
  const checkpoint = { type: 'planning.checkpoint', expectedGoalRevision: 1, summary: 'Saved full note', frontier: 'next',
    memory: { planNote: { expectedRevision: 0, body: text, frontier: 'next', changeSummary: 'Created',
      backlog: [{ id: 'later', objective: 'Required later work', reason: 'Needs output', dependsOn: ['a'], trigger: 'First phase accepted', required: true, status: 'pending' }] } } }
  assert.equal((await f.execute(checkpoint, planner.source, 'note-write')).status, 'applied')
  assert.equal((await f.execute(checkpoint, planner.source, 'note-write')).status, 'duplicate')
  assert.equal((await f.execute(checkpoint, planner.source, 'stale-note')).code, 'PLAN_NOTE_CHANGED')
  assert.equal((await access.note()).bodyCharacters, text.length)
  const before = await f.get()
  assert.ok(JSON.stringify(assembleRoleInput(before, before.executions[caller.executionId!], before.pendingActions[planner.action.id])).length < 30_000)
  let query: TaskMemoryQuery | undefined = { ref: memoryRef('one', 'note'), limit: 1 }, serialized = ''
  while (query) {
    const page = queryTaskMemory(before, before.executions[caller.executionId!], query)
    assert.ok((page.text?.length ?? 0) <= 32768)
    serialized += page.text ?? JSON.stringify(page.entries); query = page.next
  }
  assert.equal(JSON.parse(serialized)[0].body, text)
  let cursor: number | undefined = 0, body = ''
  while (cursor !== undefined) { const page = await access.read(record.ref, cursor); body += page.text; cursor = page.nextCursor }
  assert.equal(body, text)
  await assert.rejects(new TaskRecordAccess(f.tasks, { ...caller, agentId: 'different' }).read(record.ref), /RECORD_OWNER/)
  await assert.rejects(new TaskRecordAccess(f.tasks, { assistantId: 'different', role: 'foreground' }).read(record.ref), /RECORD_SCOPE/)
  assert.equal((await f.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 0, strategy: 'First phase',
    children: [childSpec('a'), childSpec('b')] }, planner.source)).status, 'applied')
  assert.equal((await access.append('planner-memory', text, 'raw-note')).ref, record.ref, 'closed owner can replay an already saved command')
  await assert.rejects(access.append('planner-memory', 'new', 'new-after-close'), /RECORD_OWNER/)
  const worker = await f.bind('dispatch', 'a')
  const replies = new TaskRecordAccess(f.tasks, { ...caller, role: 'worker', executionId: worker.execution.executionId, agentId: worker.source.id, sessionId: worker.source.sessionId })
  const reply = await replies.append('worker-reply', text, 'full-reply')
  assert.equal((await replies.read(reply.ref)).text, text.slice(0, 8192))
  await assert.rejects(replies.page({ kind: 'worker-reply', taskId: 'one', childId: 'b' }), /RECORD_SCOPE/)
  await assert.rejects(replies.append('planner-memory', 'wrong role', 'wrong'), /RECORD_ROLE/)
  const latest = await f.get(), hot = assembleRoleInput(latest, worker.execution, worker.action)
  assert.deepEqual(hot.authority.currentGoal, { revision: 1, exactRef: memoryRef('one', 'goal') })
  assert.ok(JSON.stringify(hot).length < 30_000)
  const direct = await replies.context(latest, worker.execution)
  assert.ok(direct.assignmentRef)
  assert.ok(direct.streams.find(stream => stream.scope.kind === 'task-origin')!.recent.every(entry => !('excerpt' in entry)))
})

test('T07: completed immediate Child cannot hide required future backlog', async () => {
  const f = await fixture(), planner = await f.bind('plan')
  assert.equal((await f.execute({ type: 'planning.commit', expectedGoalRevision: 1, expectedPlanRevision: 0, strategy: 'Immediate work',
    children: [childSpec()], memory: { planNote: { expectedRevision: 0, body: 'Later required stage', frontier: 'First work',
      changeSummary: 'Initial', backlog: [{ id: 'later', objective: 'Final required stage', reason: 'Need phase one', dependsOn: ['a'], trigger: 'Phase one done', required: true, status: 'pending' }] } } }, planner.source)).status, 'applied')
  const worker = await f.bind('dispatch')
  assert.equal((await f.execute({ type: 'execution.report', report: { resultId: 'done', assignmentVersion: 1, outcome: 'complete', summary: 'Finished', frontier: 'Evaluate', artifacts: [], evidence: ['Verified output'] } }, worker.source)).status, 'applied')
  const evaluator = await f.bind('evaluate')
  const receipt = await f.execute({ type: 'planning.decide', expectedGoalRevision: 1, summary: 'Accepted immediate work',
    decisions: [{ childId: 'a', resultId: 'done', outcome: 'accept', reason: 'Verified' }],
    deliver: { id: 'delivery', summary: 'All done', artifacts: [] } }, evaluator.source)
  assert.equal(receipt.code, 'REQUIRED_BACKLOG')
  assert.equal((await f.get()).delivery, undefined)
})
