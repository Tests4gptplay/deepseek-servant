import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Agents from '@deepseek-ai/dsh-agent'
import JobsLocal from '@deepseek-ai/dsh-jobs-local'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { StoragePort } from '../src/contracts/ports.js'
import { withSnapshot } from '../src/framework/transactions.js'
import { LocalFiles } from '../src/framework/local-files.js'
import { initializeTask, paths } from '../src/framework/task-files.js'
import { FrameworkRoleRuntime } from '../src/framework/role-runtime.js'
import { MockAdapter, textResponse } from './fixtures/official-mock-adapter.js'

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'dss-admission-')), ctx = new Context(), files = await LocalFiles.open(join(root, 'files'))
  const rows = new Map<string, unknown>(), errors: unknown[] = [], logs: any[] = []
  const storage: StoragePort = { get: async <T>(key: string) => rows.get(key) as T | undefined,
    set: async <T>(key: string, value: T) => { rows.set(key, structuredClone(value)) },
    list: async <T>(prefix: string) => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as T })) }
  ctx.logger.exporter({ export: event => { logs.push(event) } })
  const runtime = new FrameworkRoleRuntime(ctx, files, storage, { scope: root, member: 'A', primary: true, workspace: root,
    workerSeats: 1, mode: 'local', collaborationId: 'admission' }, { members: () => ['A'], resources: () => [], heartbeat: async () => {}, error: error => { errors.push(error) } })
  const internal = runtime as any, cleanups: Array<() => Promise<void> | void> = []
  let now = 1_000; internal.admissionNow = () => now
  t.after(async () => { for (const cleanup of cleanups) await cleanup(); await runtime.dispose(); await ctx.fiber.dispose(); await files.close(); await rm(root, { recursive: true, force: true }) })
  return { root, ctx, files, rows, errors, logs, runtime, internal, cleanups, advance: (value: number) => { now = value },
    wakes: () => [...rows.values()].filter((value: any) => value?.request?.role) as any[] }
}

// Real native admission, provider requests, Host logger and durable wake receipts.
// Only the original gateway stat dependency and clock are held/controlled.
test('eligible Foreground admission held: 45s starts real Helper independently; completed Task Recorder later continues', { timeout: 20_000 }, async t => {
  const f = await fixture(t), { ctx, runtime, internal, files } = f
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections, SystemPrompt, Tools, Agents, JobsLocal]) await ctx.plugin(plugin)
  await ctx.plugin(JsonlPersistence, { root: join(f.root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentDefaultModel, { provider: 'controlled', model: 'admission' }); await ctx.plugin(AgentLoop, { agents: [] })
  const helperStarted = Promise.withResolvers<void>(), recorderStarted = Promise.withResolvers<void>()
  const adapter = new MockAdapter(Array.from({ length: 8 }, () => (() => {
    const active = [...internal.roleRecords.values()].find((record: any) => runtime.native.get(record.identity.workId)?.actualAgent.status === 'running') as any
    if (active?.identity.role === 'Helper') helperStarted.resolve()
    if (active?.identity.role === 'Recorder') recorderStarted.resolve()
    return textResponse('Actual native role completed its admitted input.')
  })))
  ctx.llm.registerAdapter(['controlled'], adapter)
  const source = 'tasks/admission_P.md'
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: source, content: 'Synthetic complete task' }], 'fixture'))
  const task = await withSnapshot(files, async snapshot => { const plan = await initializeTask(files, snapshot, source, 'A', []); await files.commit(snapshot, plan.changes, 'fixture'); return plan.value })
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: paths.task(task.taskId), content: JSON.stringify({ ...task, status: 'complete' }) }], 'fixture-complete'))
  await runtime.wake({ id: 'held-foreground', role: 'Foreground', reason: 'notification', sources: [] })
  await runtime.wake({ id: 'complete-recorder', role: 'Recorder', taskId: task.taskId, reason: 'business-complete', sources: [] })
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), exists = internal.gateway.exists.bind(internal.gateway)
  internal.gateway.exists = async (sessionId: string) => {
    const record = [...internal.roleRecords.values()].find((value: any) => value.sessionId === sessionId) as any
    if (record?.identity.role === 'Foreground') { entered.resolve(); await gate.promise }
    return exists(sessionId)
  }
  let pumping: Promise<void> | undefined
  f.cleanups.push(async () => { gate.resolve(); await pumping })
  await (runtime.loop as any).actions.observeLocal(); pumping = internal.pump(); await entered.promise
  f.advance(45_999); await (runtime.loop as any).actions.observeLocal(); assert.equal(f.errors.length, 0)
  f.advance(46_000); await (runtime.loop as any).actions.observeLocal()
  assert.ok(f.wakes().find(row => row.request.id === 'admission-timeout:complete-recorder'), 'complete Task Recorder is diagnosed, not omitted by running Task filtering')
  await helperStarted.promise
  assert.ok(f.logs.some(event => event.type === 'error' && String(event.args[0]).includes('45 seconds')), 'formal Host logger receives the failure')
  await internal.helperPumping
  const originalFailures = () => f.errors.filter(error => /\"wakeId\":\"(?:held-foreground|complete-recorder)\"/.test(String(error))).length
  const before = originalFailures(); f.advance(100_000); await (runtime.loop as any).actions.observeLocal(); assert.equal(originalFailures(), before, 'same pending admission does not emit another failure')
  gate.resolve(); await pumping; await recorderStarted.promise
  assert.equal(f.wakes().find(row => row.request.id === 'complete-recorder').delivered, true)
  assert.equal(f.wakes().find(row => row.request.id === 'held-foreground').delivered, true)
  f.advance(200_000); await (runtime.loop as any).actions.observeLocal(); assert.equal(originalFailures(), before, 'success cannot be rediagnosed by its old clock')
})

test('paused and capacity waiting wakes start a new eligible clock; Helper admission failure never recurses', async t => {
  const f = await fixture(t), { runtime, internal } = f
  internal.startHelperAdmission = () => {} // Isolate diagnostic eligibility, not a claimed native start.
  await runtime.wake({ id: 'paused', role: 'Planner', taskId: 'T', reason: 'notification', sources: [] })
  await runtime.controls.setTask('pause', 'T', 'paused')
  await internal.checkWakeAdmissions(); f.advance(100_000); await internal.checkWakeAdmissions()
  assert.equal(f.wakes().find(row => row.request.id === 'paused').admission, undefined)
  await runtime.controls.setTask('resume', 'T', 'running'); await internal.checkWakeAdmissions()
  assert.equal(f.wakes().find(row => row.request.id === 'paused').admission.eligibleSince, 100_000)
  f.advance(144_999); await internal.checkWakeAdmissions(); assert.equal(f.errors.length, 0)
  f.advance(145_000); await internal.checkWakeAdmissions(); assert.equal(f.errors.length, 1)
  const helper = f.wakes().find(row => row.request.role === 'Helper'); assert.ok(helper)
  await internal.checkWakeAdmissions(); f.advance(190_000); await internal.checkWakeAdmissions()
  assert.equal(f.errors.length, 2); assert.equal(f.wakes().filter(row => row.request.role === 'Helper').length, 1)
  const occupied = { identity: { role: 'Worker', workId: 'occupied', executionId: 'busy' }, sessionId: 'busy', generation: 1 }
  internal.roleRecords.set('occupied', occupied); internal.workerSeatOccupied = (record: any) => record === occupied
  await runtime.wake({ id: 'capacity', role: 'Worker', taskId: 'capacity-T', workerId: 'next', reason: 'notification', sources: [] })
  await internal.checkWakeAdmissions(); f.advance(300_000); await internal.checkWakeAdmissions()
  assert.equal(f.wakes().find(row => row.request.id === 'capacity').admission, undefined)
  internal.roleRecords.delete('occupied'); await internal.checkWakeAdmissions()
  assert.equal(f.wakes().find(row => row.request.id === 'capacity').admission.eligibleSince, 300_000)
})

test('watchdog cannot erase a newer sending admission after its control read yields', async t => {
  const f = await fixture(t), { runtime, internal, rows } = f
  internal.startHelperAdmission = () => {}
  await runtime.wake({ id: 'race', role: 'Planner', taskId: 'T', reason: 'notification', sources: [] })
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  internal.controls.taskHeld = async () => { entered.resolve(); await gate.promise; return false }
  const key = [...rows].find(([, value]: any) => value?.request?.id === 'race')![0]
  const workId = internal.requestKey(f.wakes()[0].request)
  internal.roleRecords.set(workId, { identity: { workId, executionId: 'current', role: 'Planner', taskId: 'T' }, sessionId: 'current', generation: 1 })
  let active = false; internal.active = () => active
  const check = internal.checkWakeAdmissions(); await entered.promise
  active = true
  await internal.updateWake(key, (current: any) => ({ ...current, admission: { eligibleSince: 1_000, phase: 'sending', executionId: 'current' } }))
  gate.resolve(); await check
  assert.equal((rows.get(key) as any).admission?.phase, 'sending')
  f.advance(46_000); await internal.checkWakeAdmissions()
  assert.equal(f.errors.length, 1); assert.match(String(f.errors[0]), /"phase":"sending"/)
  internal.roleRecords.clear()
})

test('Helper-only admission registers ownership before callback and respects close before entry', async t => {
  const f = await fixture(t), { internal } = f
  let entered = 0
  internal.runQueue = async () => { entered++ }
  internal.startHelperAdmission()
  const owned = internal.helperPumping
  assert.ok(owned)
  internal.closed = true
  await owned
  assert.equal(entered, 0)
})

test('same work queued behind another eligible wake is not timed; an already reported wake never creates another Helper after pause/resume', async t => {
  const f = await fixture(t), { runtime, internal } = f
  internal.startHelperAdmission = () => {}
  await runtime.wake({ id: 'first', role: 'Planner', taskId: 'T', reason: 'user-resume', sources: [] })
  await runtime.wake({ id: 'second', role: 'Planner', taskId: 'T', reason: 'user-resume', sources: [] })
  await internal.checkWakeAdmissions(); f.advance(46_000); await internal.checkWakeAdmissions()
  assert.equal(f.errors.length, 1)
  assert.equal(f.wakes().find(row => row.request.id === 'second').admission, undefined)
  await runtime.controls.setTask('paused', 'T', 'paused'); await internal.checkWakeAdmissions()
  assert.equal(f.wakes().find(row => row.request.id === 'first').admission.eligibleSince, undefined)
  assert.equal(f.wakes().find(row => row.request.id === 'first').admission.reportedAt, 46_000)
  await runtime.controls.setTask('running', 'T', 'running'); f.advance(100_000); await internal.checkWakeAdmissions()
  f.advance(145_000); await internal.checkWakeAdmissions()
  assert.equal(f.errors.filter(error => String(error).includes('"wakeId":"first"')).length, 1)
  assert.equal(f.wakes().filter(row => row.request.id === 'admission-timeout:first').length, 1)
})

test('real Helper restore cancels held official creation, joins it, preserves completed Task and resumes original Recorder', { timeout: 20_000 }, async t => {
  const f = await fixture(t), { ctx, runtime, internal, files } = f
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections, SystemPrompt, Tools, Agents, JobsLocal]) await ctx.plugin(plugin)
  await ctx.plugin(JsonlPersistence, { root: join(f.root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentDefaultModel, { provider: 'controlled', model: 'admission' }); await ctx.plugin(AgentLoop, { agents: [] })
  const source = 'tasks/restore_P.md'
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: source, content: 'Preserve this original requirement.' }], 'fixture'))
  const task = await withSnapshot(files, async snapshot => { const plan = await initializeTask(files, snapshot, source, 'A', []); await files.commit(snapshot, plan.changes, 'fixture'); return plan.value })
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: paths.task(task.taskId), content: JSON.stringify({ ...task, status: 'complete' }) }], 'fixture-complete'))
  const originalSource = await withSnapshot(files, snapshot => files.read(snapshot, source))
  const entered = Promise.withResolvers<void>(), cancelled = Promise.withResolvers<void>(), helperCall = Promise.withResolvers<void>(), recorderCall = Promise.withResolvers<void>()
  const create = internal.gateway.create.bind(internal.gateway); let first = true, originalExecution = '', oldSetupExited = false
  internal.gateway.create = async (request: any) => create({ ...request, setup: async (scope: any, agent: any) => {
    if (request.role === 'recorder' && first) {
      first = false; originalExecution = [...internal.roleRecords.values()].find((record: any) => record.sessionId === request.sessionId).identity.executionId
      entered.resolve()
      try { await new Promise<void>((_resolve, reject) => {
        const abort = () => { cancelled.resolve(); reject(request.signal.reason) }
        request.signal.addEventListener('abort', abort, { once: true }); if (request.signal.aborted) abort()
      }) } finally { oldSetupExited = true }
    }
    return request.setup?.(scope, agent)
  } })
  const { toolCallResponse } = await import('./fixtures/official-mock-adapter.js')
  let helperResponded = false
  ctx.llm.registerAdapter(['controlled'], new MockAdapter(Array.from({ length: 8 }, () => ((options: any) => {
    const bodies = options.messages.map((message: any) => typeof message.content === 'string' ? message.content : message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n'))
    const diagnostic = bodies.map((text: string) => { try { return JSON.parse(text) } catch { return {} } }).find((value: any) => value.context?.target && value.context?.phase === 'opening')
    if (diagnostic && !helperResponded) { helperResponded = true; helperCall.resolve(); return toolCallResponse('restore-admission', 'dss_restore', {
      target: diagnostic.context.target, facts: 'Owned Recorder creation has not admitted the delivered Host wake.', hypotheses: 'Admission is blocked.',
      actionsTaken: 'Preserved Task and archive source.', continuation: 'Resume the original Recorder responsibility after confirmed stop.' }) }
    const active = [...internal.roleRecords.values()].find((record: any) => runtime.native.get(record.identity.workId)?.actualAgent.status === 'running') as any
    if (active?.identity.role === 'Recorder') { assert.ok(oldSetupExited); recorderCall.resolve() }
    return textResponse('Preserved original responsibility continues.')
  }))))
  await runtime.wake({ id: 'restore-recorder', role: 'Recorder', taskId: task.taskId, reason: 'business-complete', sources: [] })
  await (runtime.loop as any).actions.observeLocal(); const pumping = internal.pump(); await entered.promise
  f.cleanups.push(async () => { const record = [...internal.roleRecords.values()].find((item: any) => item.identity.executionId === originalExecution) as any; if (record) await runtime.native.cancelOpening(record.identity.workId, originalExecution); await pumping })
  f.advance(46_000); await (runtime.loop as any).actions.observeLocal(); await helperCall.promise; await internal.helperPumping
  const helper = [...internal.roleRecords.values()].find((record: any) => record.identity.role === 'Helper') as any
  await runtime.native.get(helper.identity.workId)!.whenIdle()
  assert.ok([...f.rows].some(([key, value]: any) => key.includes('/restores/') && !value.complete), 'actual native tool recorded restoration, not a stub')
  await internal.restorePending(); await cancelled.promise; await pumping
  assert.ok(oldSetupExited)
  await internal.pump(); await recorderCall.promise
  const recorder = [...internal.roleRecords.values()].find((record: any) => record.identity.role === 'Recorder') as any
  assert.notEqual(recorder.identity.executionId, originalExecution)
  assert.equal(f.wakes().find(row => row.request.id === 'restore-recorder').delivered, true, 'replacement confirmation closes the original never-admitted wake')
  await runtime.native.get(recorder.identity.workId)!.whenIdle(); await internal.pump()
  assert.ok([...f.rows].some(([key, value]: any) => key.includes('/restores/') && value.complete))
  await withSnapshot(files, async snapshot => {
    assert.equal(await files.read(snapshot, source), originalSource)
    assert.equal(JSON.parse((await files.read(snapshot, paths.task(task.taskId)))!).status, 'complete')
    assert.equal(await files.read(snapshot, paths.state(task.owner, task.taskId) + '/recovery'), '')
  })
})

test('native handle is not send confirmation: held Helper send reports sending once without recursive Helper', { timeout: 20_000 }, async t => {
  const f = await fixture(t), { ctx, runtime, internal } = f
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections, SystemPrompt, Tools, Agents, JobsLocal]) await ctx.plugin(plugin)
  await ctx.plugin(JsonlPersistence, { root: join(f.root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentDefaultModel, { provider: 'controlled', model: 'admission' }); await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['controlled'], new MockAdapter([textResponse('Native execution actually started.')]))
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), open = runtime.native.open.bind(runtime.native)
  runtime.native.open = async (...args) => {
    const owned = await open(...args), send = owned.send.bind(owned)
    owned.send = async (...input) => { await send(...input); entered.resolve(); await gate.promise }
    return owned
  }
  await runtime.wake({ id: 'helper-send', role: 'Helper', reason: 'helper', sources: [] })
  internal.startHelperAdmission(); const ownedFlight = internal.helperPumping; await entered.promise
  f.cleanups.push(async () => { gate.resolve(); await ownedFlight })
  const helper = [...internal.roleRecords.values()][0] as any
  assert.ok(runtime.native.get(helper.identity.workId))
  f.advance(46_000); await (runtime.loop as any).actions.observeLocal()
  assert.equal(f.errors.length, 1); assert.match(String(f.errors[0]), /"phase":"sending"/)
  assert.equal(f.wakes().length, 1)
  gate.resolve(); await ownedFlight
  f.advance(100_000); await (runtime.loop as any).actions.observeLocal(); assert.equal(f.errors.length, 1)
})

test('dispose cancels and drains its admitted Helper factory instead of waiting before cancellation', { timeout: 20_000 }, async t => {
  const f = await fixture(t), { ctx, runtime, internal } = f
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections, SystemPrompt, Tools, Agents, JobsLocal]) await ctx.plugin(plugin)
  await ctx.plugin(JsonlPersistence, { root: join(f.root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentDefaultModel, { provider: 'controlled', model: 'admission' }); await ctx.plugin(AgentLoop, { agents: [] })
  const entered = Promise.withResolvers<void>(), cancelled = Promise.withResolvers<void>(), create = internal.gateway.create.bind(internal.gateway)
  internal.gateway.create = (request: any) => create({ ...request, setup: async () => {
    entered.resolve()
    await new Promise<void>((_resolve, reject) => { const abort = () => { cancelled.resolve(); reject(request.signal.reason) }; request.signal.addEventListener('abort', abort, { once: true }); if (request.signal.aborted) abort() })
  } })
  await runtime.wake({ id: 'closing-helper', role: 'Helper', reason: 'helper', sources: [] })
  internal.startHelperAdmission(); await entered.promise
  await runtime.dispose(); await cancelled.promise
  assert.equal(f.errors.length, 0)
  assert.equal(f.wakes()[0].delivered, undefined)
  assert.equal([...internal.roleRecords.values()].every((record: any) => record.stopped), true)
})

test('a new restored wake can report its own later failure; the old reported wake does not silence it', async t => {
  const f = await fixture(t), { runtime, internal, rows } = f
  internal.startHelperAdmission = () => {}
  await runtime.wake({ id: 'old', role: 'Planner', taskId: 'T', reason: 'user-resume', sources: [] })
  await internal.checkWakeAdmissions(); f.advance(46_000); await internal.checkWakeAdmissions()
  const oldKey = [...rows].find(([, value]: any) => value?.request?.id === 'old')![0]
  await internal.updateWake(oldKey, (current: any) => ({ ...current, delivered: true }))
  await runtime.wake({ id: 'restore-role:new-command', role: 'Planner', taskId: 'T', reason: 'startup-recovery', sources: [] }, { targetExecutionId: 'old-execution' })
  f.advance(100_000); await internal.checkWakeAdmissions(); f.advance(145_000); await internal.checkWakeAdmissions()
  assert.equal(f.errors.filter(error => /"role":"Planner"/.test(String(error))).length, 2)
  assert.ok(f.wakes().find(row => row.request.id === 'admission-timeout:restore-role:new-command'))
  // Simulate the crash window after the durable diagnostic but before its Helper wake.
  const helperKey = [...rows].find(([, value]: any) => value?.request?.id === 'admission-timeout:restore-role:new-command')![0]
  rows.delete(helperKey); await internal.checkWakeAdmissions()
  assert.ok(rows.has(helperKey)); assert.equal(f.errors.filter(error => /"role":"Planner"/.test(String(error))).length, 2)
})

test('unconfirmed creation stop retains the original restore and admission without starting a replacement', async t => {
  const f = await fixture(t), { runtime, internal, rows } = f
  const record = { identity: { workId: 'unconfirmed', executionId: 'original', role: 'Recorder', taskId: 'T' }, sessionId: 'original', generation: 1 }
  internal.roleRecords.set(record.identity.workId, record)
  const busy = Promise.withResolvers<void>(); internal.workOperations = new Map([[record.identity.workId, busy.promise]])
  runtime.native.cancelOpening = async () => ({ status: 'unconfirmed', reason: 'Actual native cleanup has no confirmation.', jobs: [] })
  const key = internal.prefix + 'restores/unknown'
  rows.set(key, { commandId: 'unknown', createdAt: '2026-11-01T00:00:00Z', input: { target: record.identity, facts: 'pending creation' }, complete: false })
  await internal.restorePending()
  assert.equal((rows.get(key) as any).complete, false)
  assert.equal(internal.roleRecords.get(record.identity.workId).identity.executionId, 'original')
  assert.equal(internal.roleRecords.get(record.identity.workId).stopped, undefined)
  assert.match(internal.roleRecords.get(record.identity.workId).stopUnknown.reason, /no confirmation/)
  assert.equal(f.wakes().some(row => row.request.reason === 'startup-recovery'), false)
  busy.resolve(); internal.workOperations.clear(); internal.roleRecords.clear()
})

test('actual Helper restores a timed-out Recorder wake without fabricating an execution while another role admission remains held', { timeout: 20_000 }, async t => {
  const f = await fixture(t), { ctx, runtime, internal, files } = f
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections, SystemPrompt, Tools, Agents, JobsLocal]) await ctx.plugin(plugin)
  await ctx.plugin(JsonlPersistence, { root: join(f.root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentDefaultModel, { provider: 'controlled', model: 'admission' }); await ctx.plugin(AgentLoop, { agents: [] })
  const source = 'tasks/no_role_P.md'
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: source, content: 'Complete original task.' }], 'fixture'))
  const task = await withSnapshot(files, async snapshot => { const plan = await initializeTask(files, snapshot, source, 'A', []); await files.commit(snapshot, plan.changes, 'fixture'); return plan.value })
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: paths.task(task.taskId), content: JSON.stringify({ ...task, status: 'complete' }) }], 'fixture-complete'))
  const original = await withSnapshot(files, snapshot => files.read(snapshot, source))
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), recorderStarted = Promise.withResolvers<void>()
  const exists = internal.gateway.exists.bind(internal.gateway); let released = false, calls = 0
  internal.gateway.exists = async (id: string) => { const record = [...internal.roleRecords.values()].find((row: any) => row.sessionId === id) as any
    if (record?.identity.role === 'Foreground') { entered.resolve(); await gate.promise } return exists(id) }
  const { toolCallResponse } = await import('./fixtures/official-mock-adapter.js'); let asked = false
  ctx.llm.registerAdapter(['controlled'], new MockAdapter(Array.from({ length: 12 }, () => ((options: any) => {
    const bodies = options.messages.map((message: any) => typeof message.content === 'string' ? message.content : message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n'))
    const diagnostic = bodies.map((text: string) => { try { return JSON.parse(text) } catch { return {} } }).findLast((value: any) => value.context?.kind === 'admission-timeout' && value.context.role === 'Recorder')
    const active = [...internal.roleRecords.values()].find((record: any) => runtime.native.get(record.identity.workId)?.actualAgent.status === 'running') as any
    if (active?.identity.role === 'Recorder') { assert.equal(released, false); calls++; recorderStarted.resolve(); return textResponse('The actual Recorder resumed original work.') }
    if (diagnostic && !asked) { asked = true; assert.equal(diagnostic.context.target, undefined); return toolCallResponse('restore-wake', 'dss_restore', {
      wakeId: diagnostic.context.wakeId, facts: 'This precise Recorder wake has not been admitted.', hypotheses: 'Another admission is blocked.', actionsTaken: 'Preserved source and completion.', continuation: 'Resume original Recorder only.' }) }
    return textResponse('Preserve the pending responsibility.')
  }))))
  await runtime.wake({ id: 'other-held', role: 'Foreground', reason: 'notification', sources: [] })
  await runtime.wake({ id: 'never-admitted-recorder', role: 'Recorder', taskId: task.taskId, reason: 'business-complete', sources: [] })
  await (runtime.loop as any).actions.observeLocal(); const pumping = internal.runQueue(false, 'other-held'); await entered.promise
  f.cleanups.push(async () => { released = true; gate.resolve(); await pumping })
  f.advance(46_000)
  for (let turn = 0; turn < 2; turn++) {
    await (runtime.loop as any).actions.observeLocal(); await internal.helperPumping
    const helper = [...internal.roleRecords.values()].find((record: any) => record.identity.role === 'Helper') as any
    await runtime.native.get(helper.identity.workId)!.whenIdle()
  }
  assert.equal(asked, true)
  await (runtime.loop as any).actions.observeLocal(); await internal.restoring
  await Promise.all([...internal.targetedPumps.values()]); await recorderStarted.promise
  await (runtime.loop as any).actions.observeLocal(); await internal.restoring
  const restored: any = [...f.rows].find(([key, value]: any) => key.includes('/restores/') && value.input.wakeId)?.[1]
  assert.equal(restored.complete, true); assert.equal(restored.resolvedTarget, undefined)
  assert.equal(f.wakes().find(row => row.request.id === 'never-admitted-recorder').delivered, true)
  await withSnapshot(files, async snapshot => { assert.equal(await files.read(snapshot, source), original); assert.equal(await files.read(snapshot, paths.state(task.owner, task.taskId) + '/recovery'), '') })
  released = true; gate.resolve(); await pumping
  await internal.pump(); assert.equal(calls, 1, 'the old full-queue snapshot cannot redeliver the adopted original wake')
})

test('a late Helper admission diagnosis cannot stop an already confirmed original wake', async t => {
  const f = await fixture(t), { runtime, internal, rows } = f
  const target = { workId: internal.roleKey('Recorder', 'T'), executionId: 'target-e', role: 'Recorder' as const, taskId: 'T' }
  const wake = { id: 'already-sent', role: 'Recorder' as const, taskId: 'T', reason: 'business-complete' as const, sources: [] }
  await runtime.wake(wake)
  const wakeKey = [...rows].find(([, value]: any) => value?.request?.id === wake.id)![0]
  internal.roleRecords.set(target.workId, { identity: target, sessionId: 'target-s', generation: 1, delivery: { request: wake, messageId: 'native-original', confirmed: true } })
  const helper = { workId: 'helper', executionId: 'helper-e', role: 'Helper' as const, owner: 'A' }
  internal.roleRecords.set(helper.workId, { identity: helper, sessionId: 'helper-s', generation: 1,
    lastWake: { id: 'diagnostic', role: 'Helper', reason: 'helper', sources: [], context: { kind: 'admission-timeout', wakeId: wake.id, workId: target.workId, executionId: target.executionId } } })
  runtime.native.stop = async () => { throw new Error('late diagnosis attempted to stop an already-started execution') }
  await internal.services().helper.restore(helper, { target, facts: 'old timeout', hypotheses: 'inspect', actionsTaken: 'none', continuation: 'continue' }, 'late-tool')
  await internal.processRestores()
  const command = [...rows].find(([key]) => key.includes('/restores/'))![1] as any
  assert.equal(command.complete, true); assert.equal(command.outcome, 'already-admitted')
  assert.equal((rows.get(wakeKey) as any).delivered, true)
  internal.roleRecords.clear()
})

for (const boundary of ['eligibility', 'actual-admission'] as const) test(`a recovery wake adopted by a later recovery keeps only the child responsibility at ${boundary}`, async t => {
  const f = await fixture(t), { runtime, internal } = f
  internal.startHelperAdmission = () => {}
  internal.active = () => false
  await runtime.wake({ id: 'root-wake', role: 'Foreground', reason: 'user-resume', sources: [] })
  await runtime.wake({ id: 'restore-wake:first', role: 'Foreground', reason: 'startup-recovery', sources: [] }, { replacesUnadmittedWake: 'root-wake' })
  await runtime.wake({ id: 'restore-wake:second', role: 'Foreground', reason: 'startup-recovery', sources: [] }, { replacesUnadmittedWake: 'restore-wake:first' })
  f.cleanups.push(() => { internal.roleRecords.clear() })
  if (boundary === 'eligibility') {
    await internal.checkWakeAdmissions()
    assert.equal(f.wakes().find(row => row.request.id === 'restore-wake:first').admission, undefined)
    assert.equal(f.wakes().find(row => row.request.id === 'restore-wake:second').admission?.eligibleSince, 1_000)
  } else {
    const sends: string[] = []
    internal.gateway.exists = async () => false
    runtime.native.open = async (_identity: any, _options: any) => ({ send: async (_text: string, id: string) => { sends.push(id) } }) as any
    await internal.runQueue(false, 'restore-wake:first')
    assert.deepEqual(sends, [], 'a stale targeted flight for the adopted parent cannot admit another native input')
    assert.equal(f.wakes().find(row => row.request.id === 'root-wake').delivered, undefined)
  }
})

test('successful child recovery confirms the whole adopted never-admitted wake chain, not only its immediate parent', async t => {
  const f = await fixture(t), { runtime, internal } = f
  internal.startHelperAdmission = () => {}; internal.active = () => false
  await runtime.wake({ id: 'root', role: 'Foreground', reason: 'user-resume', sources: [] })
  await runtime.wake({ id: 'parent', role: 'Foreground', reason: 'startup-recovery', sources: [] }, { replacesUnadmittedWake: 'root' })
  await runtime.wake({ id: 'child', role: 'Foreground', reason: 'startup-recovery', sources: [] }, { replacesUnadmittedWake: 'parent' })
  const sends: string[] = []; internal.gateway.exists = async () => false
  runtime.native.open = async () => ({ send: async (_text: string, id: string) => { sends.push(id) } }) as any
  f.cleanups.push(() => { internal.roleRecords.clear() })
  await internal.runQueue(false, 'child')
  assert.equal(f.wakes().find(row => row.request.id === 'child').delivered, true)
  assert.equal(f.wakes().find(row => row.request.id === 'parent').delivered, true)
  assert.equal(f.wakes().find(row => row.request.id === 'root').delivered, true, 'the original responsibility has been fulfilled through its confirmed adoption chain')
  await internal.runQueue()
  assert.equal(sends.length, 1, 'no ancestor of the confirmed child is re-admitted')
})

for (const committed of [false, true]) test(`adopted ancestry acknowledgement loss at second ancestor (${committed ? 'committed' : 'not committed'}) resumes confirmation without another native send`, async t => {
  const f = await fixture(t), { runtime, internal, rows } = f
  internal.startHelperAdmission = () => {}; internal.active = () => false
  await runtime.wake({ id: 'ack-root', role: 'Foreground', reason: 'user-resume', sources: [] })
  await runtime.wake({ id: 'ack-parent', role: 'Foreground', reason: 'startup-recovery', sources: [] }, { replacesUnadmittedWake: 'ack-root' })
  await runtime.wake({ id: 'ack-child', role: 'Foreground', reason: 'startup-recovery', sources: [] }, { replacesUnadmittedWake: 'ack-parent' })
  const rootKey = [...rows].find(([, value]: any) => value?.request?.id === 'ack-root')![0]
  const originalSet = internal.records.set.bind(internal.records)
  const failure = new Error('Second ancestor persistence acknowledgement is unknown')
  let injected = false
  internal.records.set = async (key: string, value: any) => {
    if (!injected && key === rootKey && value.delivered) {
      injected = true
      if (committed) await originalSet(key, value)
      throw failure
    }
    return originalSet(key, value)
  }
  const sends: string[] = []; internal.gateway.exists = async () => false
  runtime.native.open = async () => ({ send: async (_text: string, id: string) => { sends.push(id) } }) as any
  f.cleanups.push(() => { internal.records.set = originalSet; internal.roleRecords.clear() })
  await internal.runQueue(false, 'ack-child')
  assert.equal(injected, true)
  assert.equal(sends.length, 1)
  assert.equal(f.wakes().find(row => row.request.id === 'ack-parent').delivered, true)
  assert.equal(f.wakes().find(row => row.request.id === 'ack-root').delivered, committed ? true : undefined)
  assert.equal(f.wakes().find(row => row.request.id === 'ack-child').delivered, undefined)
  assert.ok(f.errors.includes(failure), 'the original persistence uncertainty remains visible')
  assert.equal([...internal.roleRecords.values()].some((record: any) => record.delivery?.request.id === 'ack-child' && record.delivery.confirmed), true)
  await internal.runQueue(false, 'ack-child')
  assert.equal(sends.length, 1, 'confirmed native input is not repeated to repair technical acknowledgements')
  assert.equal(f.wakes().find(row => row.request.id === 'ack-root').delivered, true, 'replay finishes the whole ancestry even when the immediate parent was already confirmed')
  assert.equal(f.wakes().find(row => row.request.id === 'ack-parent').delivered, true)
  assert.equal(f.wakes().find(row => row.request.id === 'ack-child').delivered, true)
  await internal.runQueue(false, 'ack-root'); await internal.runQueue(false, 'ack-parent')
  assert.equal(sends.length, 1, 'no adopted ancestor remains eligible for a second native admission')
})

test('empty admission observation does not enter Helper pump, while persisted error and new 45s work do', async t => {
  const f = await fixture(t); let starts = 0
  f.internal.startHelperAdmission = () => { starts++ }
  await f.internal.checkWakeAdmissions(); await f.internal.checkWakeAdmissions()
  assert.equal(starts, 0)
  f.internal.error(new Error('actual Host fault')); await f.internal.errorTail
  await f.internal.checkWakeAdmissions(); assert.equal(starts, 1)
  for (const row of f.wakes().filter(row => row.request.role === 'Helper')) {
    row.delivered = true
    for (const [key, value] of f.rows) if ((value as any).request?.id === row.request.id) f.rows.set(key, row)
  }
  starts = 0
  await f.runtime.wake({ id: 'new-recorder', role: 'Recorder', taskId: 'completed-T', reason: 'business-complete', sources: [] })
  await f.internal.checkWakeAdmissions(); assert.equal(starts, 0)
  f.advance(46_000); await f.internal.checkWakeAdmissions(); assert.equal(starts, 1, 'new timeout diagnostic is admitted in this observation')
})

test('Helper added after an observation snapshot remains durably discoverable on the next local observation and cold runtime', async t => {
  const f = await fixture(t), originalList = f.internal.records.list.bind(f.internal.records)
  let inserted = false, starts = 0
  f.internal.startHelperAdmission = () => { starts++ }
  f.internal.records.list = async (prefix: string) => {
    const rows = await originalList(prefix)
    if (!inserted && prefix.endsWith('/wakes/')) {
      inserted = true
      await f.runtime.wake({ id: 'concurrent-helper', role: 'Helper', reason: 'helper', sources: [] })
    }
    return rows
  }
  await f.internal.checkWakeAdmissions(); assert.equal(starts, 0)
  await f.internal.checkWakeAdmissions(); assert.equal(starts, 1)
  const cold = new FrameworkRoleRuntime(f.ctx, f.files, f.internal.records, f.internal.config, f.internal.environment) as any
  let coldStarts = 0; cold.startHelperAdmission = () => { coldStarts++ }
  await cold.checkWakeAdmissions(); assert.equal(coldStarts, 1)
})
