import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createObservation, recordProgress, dueObservation, rebindObservation,
  createRecoveryWatch, dueRecoveryWatch, consumeRecoveryWatch,
  canConsumeRecovery, memberRecoveryEligible, scanMemberRecovery, helperRecoveryMembers,
  usesMemberRecovery, invokesHelper, StartupRecoveryBatch,
  type RecoveryRole, type MemberRecoveryInput,
} from '../src/framework/recovery.js'
const minute = 60_000
const identity = (role: RecoveryRole = 'Worker') => ({ workId: 'work', executionId: 'execution', role, taskId: 'T1', member: 'B', workerId: 'W1' })
const member = (taskId: string, bytes = 1): MemberRecoveryInput => ({ taskId, member: 'B', taskPath: `tasks/${taskId}_P.md`,
  inboxPath: `task-runs/${taskId}/B/B_Inbox`, inboxBodyBytes: 10, status: 'running', pendingBusiness: true, needsRecovery: true,
  plannerExecutionId: `${taskId}-P`, plannerMemoryPath: `${taskId}/Memory.md`, plannerExecuting: false,
  workers: [{ workerId: 'W1', executionId: `${taskId}-W1`, notePath: `${taskId}/W1/Note.md`, noteBodyBytes: bytes, executing: false }],
  pendingSignals: [`state/B/${taskId}/Planner_W1`],
})

test('ORPW receive native probe at 5, warning at 10 and restart only after another 30 minutes', () => {
  for (const role of ['Organizer', 'Planner', 'Worker', 'Recorder'] as RecoveryRole[]) {
    let state = createObservation(identity(role), 0)
    assert.equal(dueObservation(state, 5 * minute - 1).action, undefined)
    for (const [at, kind] of [[5, 'probe-role'], [10, 'warn-role'], [40, 'restart-role']] as const) {
      const result = dueObservation(state, at * minute); state = result.state
      assert.equal(result.action?.kind, kind)
      assert.equal(dueObservation(state, at * minute).action, undefined)
    }
    assert.equal(dueObservation(state, 80 * minute).action, undefined)
  }
})
test('Foreground is outside the mechanical inactivity policy', () => {
  const state = createObservation(identity('Foreground'), 0)
  for (const at of [5, 10, 40, 400]) assert.equal(dueObservation(state, at * minute).action, undefined)
})
test('Helper probes and warns directly, then restarts to overall restoration with a fresh new execution cycle', () => {
  let state = createObservation(identity('Helper'), 0)
  for (const [at, kind] of [[5, 'probe-helper'], [10, 'warn-helper'], [40, 'restore-helper']] as const) {
    const result = dueObservation(state, at * minute); state = result.state
    assert.equal(result.action?.kind, kind)
  }
  state = rebindObservation(state, 'replacement-helper', 41 * minute)
  assert.equal(state.stage, 0)
  assert.equal(dueObservation(state, 46 * minute).action?.kind, 'probe-helper')
})
test('progress resets silence but not stage; heartbeat does neither; work identities remain independent', () => {
  let state = dueObservation(createObservation(identity(), 0), 5 * minute).state
  state = recordProgress(state, 'connection-heartbeat', 6 * minute)
  assert.equal(state.lastProgressAt, 0)
  state = recordProgress(state, 'model-text', 6 * minute)
  assert.equal(state.stage, 1)
  assert.equal(dueObservation(state, 10 * minute).action, undefined)
  const result = dueObservation(state, 11 * minute)
  assert.equal(result.action?.stage, 2)
  state = recordProgress(result.state, 'reasoning', 12 * minute)
  state = recordProgress(state, 'tool-progress', 13 * minute)
  assert.equal(dueObservation(state, 42 * minute).action, undefined)
  assert.equal(dueObservation(state, 43 * minute).action?.kind, 'restart-role')
  assert.equal(createObservation({ ...identity(), workId: 'other' }, 13 * minute).stage, 0)
})
test('late checks do not collapse phases; same-execution resumption preserves stage while actual replacement starts fresh', () => {
  let state = dueObservation(createObservation(identity(), 0), 20 * minute).state
  assert.equal(dueObservation(state, 20 * minute).action, undefined)
  state = rebindObservation(state, state.identity.executionId, 22 * minute)
  assert.equal(state.stage, 1)
  assert.equal(dueObservation(state, 26 * minute).action, undefined)
  assert.equal(dueObservation(state, 27 * minute).action?.stage, 2)
  const replacement = rebindObservation(state, 'E2', 28 * minute)
  assert.equal(replacement.stage, 0); assert.equal(replacement.lastProgressAt, 28 * minute)
})
test('unconsumed recovery checks repeat every 30 minutes independently of native progress or normal assessment', () => {
  let marker = createRecoveryWatch({ taskId: 'T1', member: 'B' }, 0)
  let ai = createObservation(identity(), 0)
  assert.equal(dueRecoveryWatch(marker, 30 * minute - 1).action, undefined)
  for (const [ordinal, at] of [30, 60, 90, 120].entries()) {
    ai = recordProgress(ai, 'tool-progress', at * minute)
    assert.equal(dueObservation(ai, at * minute).action, undefined)
    const result = dueRecoveryWatch(marker, at * minute); marker = result.state
    assert.equal(result.action?.kind, 'recovery-check'); assert.equal(result.action?.stage, ordinal + 1)
    assert.equal(dueRecoveryWatch(marker, at * minute).action, undefined)
    assert.equal(marker.cycleStartedAt, 0)
  }
  const late = dueRecoveryWatch(marker, 500 * minute)
  assert.equal(late.action?.stage, 5)
  assert.equal(dueRecoveryWatch(late.state, 500 * minute).action, undefined)
})
test('only exact member Planner consumes recovery on chain arrival, without quality or all-worker ACK', () => {
  const marker = createRecoveryWatch({ taskId: 'T1', member: 'B' }, 0)
  for (const role of ['Worker', 'Helper', 'Organizer', 'Foreground', 'Recorder'] as RecoveryRole[])
    assert.throws(() => consumeRecoveryWatch(marker, { role, taskId: 'T1', member: 'B' }, true))
  assert.equal(canConsumeRecovery({ role: 'Planner', taskId: 'T2', member: 'B' }, marker), false)
  assert.equal(canConsumeRecovery({ role: 'Planner', taskId: 'T1', member: 'B1' }, marker), false)
  const actor = { role: 'Planner' as const, taskId: 'T1', member: 'B' }
  assert.equal(consumeRecoveryWatch(marker, actor, false), marker)
  assert.equal(consumeRecoveryWatch(marker, actor, true), undefined)
  assert.equal(createRecoveryWatch(marker, 50 * minute).stage, 0)
})
test('startup scans T1/T2/T3 nonzero bodies and T4 zero body to its own Planner; all notes recovered', () => {
  const t1 = member('T1')
  t1.workers = [...t1.workers, { ...t1.workers[0]!, workerId: 'W2', executionId: 'T1-W2', notePath: 'T1/W2/Note.md', noteBodyBytes: 2 }]
  const inputs = [t1, member('T2'), member('T3'), member('T4', 0)]
  const targets = scanMemberRecovery(inputs)
  assert.deepEqual(targets.map(t => [t.taskId, t.role, t.workerId]), [
    ['T1', 'Worker', 'W1'], ['T1', 'Worker', 'W2'], ['T2', 'Worker', 'W1'], ['T3', 'Worker', 'W1'], ['T4', 'Planner', undefined],
  ])
  assert.equal(targets.at(-1)?.recordPath, 'T4/Memory.md')
  assert.deepEqual(targets[0]?.pendingSignals, t1.pendingSignals)
  assert.equal(scanMemberRecovery(inputs, [targets[0]!]).length, 4)
  assert.deepEqual(inputs[0]!.pendingSignals, ['state/B/T1/Planner_W1'])
})
test('member complete and empty Inbox excluded; actual executions not restarted; rework requalifies exact member', () => {
  const complete = { ...member('T1'), status: 'complete' as const, pendingBusiness: false }
  assert.equal(memberRecoveryEligible(complete), false)
  assert.deepEqual(scanMemberRecovery([complete]), [])
  assert.equal(scanMemberRecovery([{ ...complete, pendingBusiness: true }]).length, 1)
  assert.deepEqual(scanMemberRecovery([{ ...member('T2'), inboxBodyBytes: 0 }]), [])
  const executing = member('T3'); executing.workers[0]!.executing = true
  assert.deepEqual(scanMemberRecovery([executing]), [])
  assert.deepEqual(scanMemberRecovery([{ ...member('T4', 0), plannerExecuting: true }]), [])
  assert.equal(complete.status, 'complete')
})
test('Helper candidate scan spans tasks, excludes complete and empty, and markers belong only to member P/W', () => {
  const members = [member('T1'), member('T2'), { ...member('T3'), inboxBodyBytes: 0 }, { ...member('T4'), status: 'complete' as const, pendingBusiness: false }]
  assert.deepEqual(helperRecoveryMembers(members), [{ taskId: 'T1', member: 'B' }, { taskId: 'T2', member: 'B' }])
  for (const role of ['Foreground', 'Organizer', 'Recorder', 'Helper'] as RecoveryRole[]) assert.equal(usesMemberRecovery(role, members[0]), false)
  assert.equal(usesMemberRecovery('Worker', members[0]), true)
  assert.equal(usesMemberRecovery('Planner', members[0]), true)
  assert.equal(usesMemberRecovery('Worker'), false)
  assert.equal(usesMemberRecovery('Planner'), false)
  assert.equal(invokesHelper('warning'), false)
  assert.equal(invokesHelper('no-progress-warning'), false)
  for (const trigger of ['ai-help', 'host-error'] as const) assert.equal(invokesHelper(trigger), true)
})
test('startup pauses ordinary wakeups through full scan and arrangement, not until workers finish', async () => {
  const batch = new StartupRecoveryBatch(), queued: string[] = []
  batch.collect(member('T1')); batch.collect(member('T2'))
  assert.equal(batch.ordinaryWakeupsAllowed, false)
  await assert.rejects(batch.arrange(async () => {}, async () => false), /full recovery scan/)
  assert.equal(batch.finishScan().length, 2)
  assert.equal(batch.ordinaryWakeupsAllowed, false)
  await batch.arrange(async target => { queued.push(target.taskId) }, async target => target.taskId === 'T2')
  assert.deepEqual(queued, ['T1'])
  assert.equal(batch.ordinaryWakeupsAllowed, true)
})
test('failed arrangement stays paused and retries current target through actual execution/scheduled check', async () => {
  const batch = new StartupRecoveryBatch(); batch.collect(member('T1')); batch.collect(member('T2')); batch.finishScan()
  const scheduled = new Set<string>()
  await assert.rejects(batch.arrange(async target => { scheduled.add(target.taskId); throw Error('unknown enqueue result') }, async target => scheduled.has(target.taskId)))
  assert.equal(batch.ordinaryWakeupsAllowed, false)
  await batch.arrange(async target => { scheduled.add(target.taskId) }, async target => scheduled.has(target.taskId))
  assert.deepEqual([...scheduled], ['T1', 'T2'])
  assert.equal(batch.ordinaryWakeupsAllowed, true)
})
