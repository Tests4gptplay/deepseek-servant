// Reproduce the mixed Local snapshot: stale G1 role rows, accepted recoveries,
// published G2 handoffs, and two already-queued Worker assignments. Local files,
// authoritative storage, reconciliation, reservations and admission are real;
// the stopped session read/native model boundary uses a controlled receiver.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { openDshStorageFixture } from './test-support/dsh-sdk-storage.mjs'
const { FrameworkRoleRuntime } = await import('../src/framework/role-runtime.ts')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { workerTransferPath } = await import('../src/framework/worker-business.ts')
const { paths, taskInitializationFiles } = await import('../src/framework/task-files.ts')
const hash = value => createHash('sha256').update(value).digest('hex')
const root = await fs.mkdtemp('/tmp/dss-seat-recovery-')
const sdk = await openDshStorageFixture(path.join(root, 'storage'), path.join(root, 'locator'))
const { AgentRegistry } = await import('@deepseek-ai/dsh-agent')
const { SessionStore } = await import('@deepseek-ai/dsh-session')
const { SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection')
const { LocalJobRegistry } = await import('@deepseek-ai/dsh-jobs-local')
const jsonl = await import('@deepseek-ai/dsh-session-persistence-jsonl')
new AgentRegistry(sdk.ctx)
new SessionStore(sdk.ctx)
new SessionProjectionRegistry(sdk.ctx)
new LocalJobRegistry(sdk.ctx, {})
const sessionPlugin = sdk.ctx.plugin(jsonl, { root: path.join(root, 'sessions'), compression: 'none' })
await sessionPlugin.await()
const files = new PhysicalLocalFiles(path.join(root, 'records')), records = sdk.adapter
const member = 'A', config = {
  scope: 'seat-recovery', mode: 'local', member, primary: true, workerSeats: 2,
  collaborationId: 'fixture', workspace: root, instanceUUID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}
const errors = [], accepted = [], handles = new Map()
const rt = new FrameworkRoleRuntime(sdk.ctx, files, records, config, {
  members: () => [member], resources: () => [], error: error => errors.push(String(error)),
})
// Only the native Agent gateway stops at this controlled delivery boundary.
rt.gateway.exists = async () => false
rt.native.get = (workId, executionId) => {
  const active = handles.get(workId)
  return active && (!executionId || active.identity.executionId === executionId) ? active : undefined
}
rt.native.open = async (identity, { sessionId }) => {
  const owner = { identity, sessionId, observe: () => ({ state: 'running' }), hasMessage: () => true,
    send: async (text, messageId) => accepted.push({ identity, messageId, input: JSON.parse(text) }) }
  handles.set(identity.workId, owner)
  return owner
}
rt.native.detach = (id, execution) => { if (rt.native.get(id, execution)) handles.delete(id) }
rt.workspaces.ensure = async () => undefined
// Disable the interval/pump trigger; explicit runQueue advances the same queue.
rt.startOwnedPump = () => {}
rt.stopOwnedRecord = async record => {
  if (record.identity.workerId === 'same-line') {
    rt.native.detach(record.identity.workId, record.identity.executionId)
    return { status: 'stopped' }
  }
  return { status: 'unconfirmed', reason: 'fixture native teardown unavailable', jobs: [] }
}
const wakeKey = id => rt.prefix + 'wakes/' + hash(id)
const roleKey = id => rt.roleRecordPath(id)
const taskId = '11223344-0000-4000-8000-0123456789ab'
const task = { version: 1, taskId, route: 'P', owner: member, members: [member], status: 'running',
  sourcePath: 'tasks/seat-regression_P.md', archiveFolder: taskId }
const workerKey = child => rt.roleKey('Worker', taskId, child)
const request = (child, id = 'assign-' + child, reason = 'notification') => ({
  id, role: 'Worker', taskId, workerId: child, reason, sources: [],
})
const pending = req => records.set(wakeKey(req.id), { request: req })
async function role(child, generation, extra = {}) {
  const workId = workerKey(child)
  const acceptedInput = request(child, 'previous-' + child)
  const record = {
    identity: { workId, executionId: child + '-g' + generation, role: 'Worker', taskId, member, workerId: child },
    sessionId: 'dss-' + child + '-g' + generation, generation, lastWake: acceptedInput,
    delivery: { request: acceptedInput, messageId: 'msg-prev-' + child, confirmed: true }, ...extra,
  }
  await records.set(roleKey(workId), record)
  rt.roleRecords.set(workId, record)
  return record
}
async function priorHandoff(child, { published = true, linked = true, stopped = true, lifecycle = '' } = {}) {
  const prior = await role(child, 1, { stopUnknown: { reason: 'cold session persist service missing', jobs: [] },
    nativeRetirements: [{ executionId: 'pre-existing-cleanup', sessionId: 'dss-existing-cleanup' }] })
  const delivery = request(child, 'recover-' + child, 'startup-recovery')
  const successor = {
    ...prior, identity: { ...prior.identity, executionId: child + '-g2', ...(lifecycle ? { lifecycleId: lifecycle } : {}) },
    sessionId: 'dss-' + child + '-g2', generation: 2, lastWake: delivery,
    delivery: { request: delivery, messageId: 'msg-' + child, confirmed: true },
    nativeRetirements: [{ executionId: child + '-cleanup', sessionId: 'dss-' + child + '-cleanup' }],
  }
  const retired = { ...successor, stopped, stopUnknown: stopped ? undefined : { reason: 'producer still draining after handoff', jobs: [] } }
  await records.set(rt.prefix + 'retired-workers/' + successor.identity.executionId, retired)
  await records.set(wakeKey(delivery.id), { request: delivery, delivered: true,
    recovery: { targetExecutionId: linked ? prior.identity.executionId : 'unrelated-generation' } })
  // The incomplete negative case is exercised directly before the normal
  // production reconciliation (which would otherwise resume publication).
  const transfer = { version: 1, record: successor, successorId: member, successorRole: 'Planner', physical: { published } }
  if (published) await files.replace(workerTransferPath(rt.workerBusinessScope(), successor.identity.executionId), JSON.stringify(transfer))
  return { prior, retired, transfer }
}
const wake = async req => records.get(wakeKey(req.id))
try {
  await files.replace(paths.task(taskId), JSON.stringify(task))
  await files.replace(task.sourcePath, 'Original task')
  for (const change of taskInitializationFiles(task)) await files.replace(change.path, change.content)
  await priorHandoff('battle', { stopped: false })
  const river = await priorHandoff('river')
  // The old model can still appear online. It is not the business owner.
  const oldBattle = rt.roleRecords.get(workerKey('battle'))
  handles.set(workerKey('battle'), { identity: oldBattle.identity, observe: () => ({ state: 'running' }) })
  assert.equal(rt.occupiedWorkerSeats(undefined, taskId), 2)
  const master = request('master'), royal = request('royal'), third = request('third')
  // Royal is an existing confirmed-stopped child from the current incident.
  const retiredRoyal = await role('royal', 1, { stopped: true, completedRound: true })
  await pending(royal)
  await pending(master)
  // Real queue entry before the mixed snapshot is reconciled: both are blocked.
  await rt.runQueue()
  assert.equal(accepted.length, 0)
  assert.equal((await wake(royal)).delivered, undefined)
  assert.equal((await wake(master)).delivered, undefined)
  errors.length = 0
  await rt.reconcileWorkerTransfers(true)
  const projected = rt.workerLineRecord(rt.roleRecords.get(workerKey('battle')))
  assert.equal(projected.generation, 2)
  assert.equal(projected.stopped, false)
  assert.equal(projected.businessTransferred, true)
  assert.equal(projected.nativeRetirements.length, 2)
  assert.equal(rt.native.get(workerKey('battle')).identity.executionId, oldBattle.identity.executionId)
  assert.equal(rt.roleRecords.get(workerKey('battle')).identity.executionId, oldBattle.identity.executionId)
  assert.equal((await records.get(roleKey(workerKey('battle')))).identity.executionId, oldBattle.identity.executionId)
  assert.equal((await records.get(roleKey(workerKey('river')))).identity.executionId, river.prior.identity.executionId)
  assert.equal(rt.occupiedWorkerSeats(undefined, taskId), 0)
  await rt.runQueue()
  assert.deepEqual(accepted.map(x => x.identity.workerId).sort(), ['master', 'royal'])
  assert.equal(rt.roleRecords.get(workerKey('royal')).generation, retiredRoyal.generation + 1)
  assert.equal(rt.roleRecords.get(workerKey('master')).generation, 1)
  assert.equal((await wake(royal)).delivered, true)
  assert.equal((await wake(master)).delivered, true)
  assert.equal(rt.occupiedWorkerSeats(undefined, taskId), 2)
  await pending(third)
  await rt.runQueue()
  assert.equal((await wake(third)).delivered, undefined)
  assert.equal(accepted.length, 2)
  // Same-line replacement gets the already-owned seat, not a third one.
  const sameLine = await role('same-line', 1, { stopUnknown: { reason: 'awaiting exact restoration', jobs: [] } })
  handles.delete(workerKey('royal'))
  await role('royal', 2, { stopped: true, completedRound: true })
  const replacement = request('same-line', 'same-line-replacement', 'startup-recovery')
  await records.set(wakeKey(replacement.id), { request: replacement, recovery: { targetExecutionId: sameLine.identity.executionId } })
  assert.equal(rt.occupiedWorkerSeats(undefined, taskId), 2)
  assert.equal(rt.occupiedWorkerSeats(sameLine.identity.workId, taskId), 1)
  await rt.runQueue(false, replacement.id)
  assert.equal((await wake(replacement)).delivered, true)
  assert.equal(accepted.at(-1).identity.workerId, 'same-line')
  assert.equal(rt.roleRecords.get(sameLine.identity.workId).generation, 2)
  assert.equal(rt.occupiedWorkerSeats(undefined, taskId), 2)
  assert.equal((await wake(third)).delivered, undefined)
  // G2 native disposal did not gate business release. Absent/incorrect
  // lineage and incomplete business publication are not equivalent evidence.
  for (const [child, settings] of [
    ['incorrect-target', { linked: false }], ['unpublished', { published: false }], ['other-lifecycle', { lifecycle: 'different' }],
  ]) {
    const { prior, retired, transfer } = await priorHandoff(child, settings)
    await rt.reconcileTransferredWorkerLine(transfer, retired)
    assert.equal(rt.workerLineRecord(prior), prior)
    assert.equal(rt.workerSeatOccupied(prior), true)
  }
  const offline = await role('owned-offline', 1, { stopped: true })
  assert.equal(rt.workerSeatOccupied(offline), true)
  const abandoned = await role('not-admitted', 1, { lastWake: undefined, delivery: undefined,
    stopUnknown: { reason: 'not an accepted work line', jobs: [] } })
  handles.set(abandoned.identity.workId, { identity: abandoned.identity, observe: () => ({ state: 'running' }) })
  assert.equal(rt.workerSeatOccupied(abandoned), false)
  assert.equal(errors.filter(x => !x.includes('fixture native teardown unavailable')).length, 0, errors.join('\n'))
  console.log('PASS: Local cold reconciliation, two blocked/then delivered assignments, same-line replacement at capacity, third-line exclusion, negative lineage/lifecycle/publication and cleanup preservation.')
} finally {
  rt.closed = true
  await Promise.allSettled([...rt.workerDrains?.values() ?? [], ...rt.nativeRetirementOperations?.values() ?? []])
  await sessionPlugin.dispose()
  await files.close()
  await sdk.close()
  await fs.rm(root, { recursive: true, force: true })
}
