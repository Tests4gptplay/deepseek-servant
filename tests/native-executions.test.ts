import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { DshAgentGateway } from '../src/adapters/dsh/agents.js'
import type { OwnedDshAgent } from '../src/adapters/dsh/host-types.js'
import type { ExecutionObservations, ScheduledObservation } from '../src/framework/execution-observation.js'
import { NativeExecutions, pendingNativeStopJobs, type NativeStopEvidenceHooks, type NativeStopEvidence } from '../src/framework/native-executions.js'
import type { WorkIdentity } from '../src/framework/recovery.js'

// Adapter boundary tests: the fake event source is not evidence of real Host quiescence.
function fixture(job = false, evidence?: NativeStopEvidenceHooks, host?: Context) {
  const listeners = new Set<(session: unknown, event: any) => void>()
  const history: any[] = []
  const session = { snapshotEvents: () => history }, agent = { id: 'session', session }
  let dispose: () => Promise<void> = async () => {}, count = 0, unbound = false, recoverable = true, hasJob = job, bindFailure = false
  const roles: string[] = []
  const handle = { sessionId: 'session', actualAgent: agent, dispose: async () => { assert.equal(unbound, true); count++; await dispose() },
    observe: () => ({ state: 'running', jobs: hasJob ? [{ id: 'job', owner: 'session', status: 'running' }] : [] }) } as unknown as OwnedDshAgent
  const ctx = host ?? { on: (name: string, listener: (session: unknown, event: any) => void) => {
    assert.equal(name, 'session/event'); listeners.add(listener); return () => { listeners.delete(listener) }
  } } as unknown as Context
  const gateway = { create: async (request: { role: string }) => { roles.push(request.role); return handle } } as unknown as DshAgentGateway
  const observations = { bind: async () => { unbound = false; if (bindFailure) throw new Error('observation persistence failed') }, unbind: async () => { unbound = true }, mayApply: async () => recoverable } as unknown as ExecutionObservations
  const runtime = new NativeExecutions(ctx, gateway, observations, evidence)
  const identity: WorkIdentity = { workId: 'work', executionId: 'exec', role: 'Helper' }
  return { runtime, identity, handle, roles, setDispose: (fn: typeof dispose) => { dispose = fn }, count: () => count,
    failBind: () => { bindFailure = true }, clearJobs: () => { hasJob = false }, subscriptions: () => listeners.size, recoverable: (value: boolean) => { recoverable = value },
    history,
    registered: (id = 'late-job', owner = 'session') => { const event = { type: 'job/registered', data: { jobId: id, owner } }; history.push(event); for (const listener of listeners) listener(session, event) },
    settled: (producerReported: boolean, owner = 'session') => { const event = { type: 'job/settled', data: { jobId: 'job', owner, producerReported } }; history.push(event); for (const listener of listeners) listener(session, event) } }
}
const request = { sessionId: 'session', cwd: '/isolated-boundary' }

test('six role mapping uses native factory and duplicate execution reuses owned handle', async () => {
  for (const role of ['Foreground', 'Organizer', 'Planner', 'Worker', 'Recorder', 'Helper'] as const) {
    const f = fixture()
    assert.equal(await f.runtime.open({ ...f.identity, role }, request), f.handle)
    assert.equal(await f.runtime.open({ ...f.identity, role }, request), f.handle)
    assert.deepEqual(f.roles, [role.toLowerCase()])
  }
})
test('stop awaits real disposal promise and invalidates observation first', async () => {
  const f = fixture(), release = Promise.withResolvers<void>()
  f.setDispose(() => release.promise)
  await f.runtime.open(f.identity, request)
  let finished = false
  const stopping = f.runtime.stop('work', 'exec').then(result => { finished = true; return result })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(finished, false)
  release.resolve()
  assert.deepEqual(await stopping, { status: 'stopped' })
  assert.equal(f.runtime.get('work'), undefined)
  assert.equal(f.subscriptions(), 0)
})
test('native dispose failure remains unconfirmed and cannot silently open a replacement', async () => {
  const f = fixture(); f.setDispose(async () => { throw new Error('native disposal failed') })
  await f.runtime.open(f.identity, request)
  assert.equal((await f.runtime.stop('work', 'exec')).status, 'unconfirmed')
  await assert.rejects(f.runtime.open({ ...f.identity, executionId: 'next' }, request), /native disposal failed/)
  assert.equal(f.subscriptions(), 0)
})
test('forced or missing job settlement never counts as confirmed producer stop', async () => {
  for (const value of [false, undefined]) {
    const f = fixture(true)
    f.setDispose(async () => { if (value !== undefined) f.settled(value); f.settled(true, 'other-owner') })
    await f.runtime.open(f.identity, request)
    const result = await f.runtime.stop('work', 'exec')
    assert.equal(result.status, 'unconfirmed')
    if (result.status === 'unconfirmed') assert.deepEqual(result.jobs, ['job'])
  }
  const f = fixture(true); f.setDispose(async () => { f.settled(true) })
  await f.runtime.open(f.identity, request)
  assert.deepEqual(await f.runtime.stop('work', 'exec'), { status: 'stopped' })
})
test('superseded execution or newly progressing work is not stopped by a queued recovery action', async () => {
  const f = fixture(); await f.runtime.open(f.identity, request)
  assert.deepEqual(await f.runtime.stop('work', 'old'), { status: 'superseded' })
  f.recoverable(false)
  assert.deepEqual(await f.runtime.stop('work', 'exec', {} as ScheduledObservation), { status: 'superseded' })
  assert.equal(f.count(), 0)
  assert.equal(f.runtime.get('work'), f.handle)
})

test('retry cannot promote a previously unconfirmed producer to stopped after registry removal', async () => {
  const f = fixture(true); f.setDispose(async () => { f.settled(false) })
  await f.runtime.open(f.identity, request)
  assert.equal((await f.runtime.stop('work', 'exec')).status, 'unconfirmed')
  f.clearJobs(); f.setDispose(async () => {})
  const retry = await f.runtime.stop('work', 'exec')
  assert.equal(retry.status, 'unconfirmed')
  if (retry.status === 'unconfirmed') assert.deepEqual(retry.jobs, ['job'])
  assert.equal(f.runtime.get('work'), f.handle)
})

test('failed observation binding retains ownership when native cleanup cannot confirm producers', async () => {
  const f = fixture(true); f.failBind(); f.setDispose(async () => { f.settled(false) })
  await assert.rejects(f.runtime.open(f.identity, request), /binding and native cleanup failed/)
  assert.equal(f.runtime.get('work'), f.handle)
  await assert.rejects(f.runtime.open({ ...f.identity, executionId: 'next' }, request), /producer settlement/)
  assert.equal(f.roles.length, 1)
})

test('a missed recorded settlement can resolve stop without inventing an empty-registry confirmation', async () => {
  const f = fixture(true); await f.runtime.open(f.identity, request)
  assert.equal((await f.runtime.stop('work', 'exec')).status, 'unconfirmed')
  assert.equal(f.subscriptions(), 0)
  f.settled(true) // Durable event exists, but no transient observer was subscribed.
  f.clearJobs()
  assert.deepEqual(await f.runtime.stop('work', 'exec'), { status: 'stopped' })
})


test('durable stopping intent is awaited before disposal; durable confirmation is awaited before success', async () => {
  const entered = Promise.withResolvers<void>(), initial = Promise.withResolvers<void>(), confirmed = Promise.withResolvers<void>()
  const writes: NativeStopEvidence[] = []
  const f = fixture(false, { save: async value => {
    writes.push(structuredClone(value))
    if (value.phase === 'stopping') { entered.resolve(); await initial.promise }
    else await confirmed.promise
  } })
  await f.runtime.open(f.identity, request)
  let done = false
  const result = f.runtime.stop('work', 'exec').then(value => { done = true; return value })
  await entered.promise
  assert.equal(f.count(), 0)
  assert.deepEqual(writes[0], { workId: 'work', executionId: 'exec', agentId: 'session', sessionId: 'session', jobs: [], phase: 'stopping' })
  initial.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.count(), 1); assert.equal(done, false)
  confirmed.resolve()
  assert.deepEqual(await result, { status: 'stopped' })
  assert.equal(writes.at(-1)!.phase, 'disposed')
})

test('failure to persist stopping intent cannot dispose or falsely acknowledge stop', async () => {
  const f = fixture(true, { save: async () => { throw new Error('durable evidence unavailable') } })
  await f.runtime.open(f.identity, request)
  const result = await f.runtime.stop('work', 'exec')
  assert.equal(result.status, 'unconfirmed'); assert.equal(f.count(), 0)
  if (result.status === 'unconfirmed') assert.deepEqual(result.jobs, ['job'])
  await assert.rejects(f.runtime.open({ ...f.identity, executionId: 'replacement' }, request), /evidence unavailable/)
})

test('late registration during dispose is serialized durably and prevents stopped despite empty registry', async () => {
  const writes: NativeStopEvidence[] = [], late = Promise.withResolvers<void>(), saved = Promise.withResolvers<void>()
  const f = fixture(false, { save: async value => {
    if (value.jobs.includes('late-job')) { late.resolve(); await saved.promise }
    writes.push(structuredClone(value))
  } })
  f.setDispose(async () => { f.registered(); f.registered('foreign', 'other-owner') })
  await f.runtime.open(f.identity, request)
  let finished = false
  const stopping = f.runtime.stop('work', 'exec').then(result => { finished = true; return result })
  await late.promise
  assert.equal(finished, false)
  saved.resolve()
  const result = await stopping
  assert.equal(result.status, 'unconfirmed')
  if (result.status === 'unconfirmed') assert.deepEqual(result.jobs, ['late-job'])
  assert.deepEqual(writes.at(-1)!.jobs, ['late-job'])
  assert.equal(writes.at(-1)!.phase, 'stopping')
})

test('failed evidence update or final acknowledgement after native disposal never returns stopped', async () => {
  for (const failedPhase of ['update', 'disposed']) {
    let saves = 0
    const f = fixture(false, { save: async value => {
      saves++
      if (failedPhase === 'disposed' ? value.phase === 'disposed' : saves === 2) throw new Error('evidence write failed')
    } })
    if (failedPhase === 'update') f.setDispose(async () => { f.registered() })
    await f.runtime.open(f.identity, request)
    assert.equal((await f.runtime.stop('work', 'exec')).status, 'unconfirmed')
    assert.equal(f.count(), 1)
    assert.equal(f.runtime.get('work'), f.handle)
  }
})

test('cold stop evidence retains absent jobs and requires exact-owner producer settlement, including late real settlement', () => {
  assert.deepEqual(pendingNativeStopJobs('session', [], ['remembered']), ['remembered'])
  const events: any[] = [
    { type: 'job/registered', data: { owner: 'session', jobId: 'new' } },
    { type: 'job/settled', data: { owner: 'other', jobId: 'remembered', producerReported: true } },
    { type: 'job/settled', data: { owner: 'session', jobId: 'new', producerReported: false } },
  ]
  assert.deepEqual(pendingNativeStopJobs('session', events, ['remembered']), ['new', 'remembered'])
  events.push({ type: 'job/settled', data: { owner: 'session', jobId: 'remembered', producerReported: true } })
  assert.deepEqual(pendingNativeStopJobs('session', events, ['remembered']), ['new'])
  events.push({ type: 'job/settled', data: { owner: 'session', jobId: 'new', producerReported: true } })
  assert.deepEqual(pendingNativeStopJobs('session', events, ['remembered']), [])
})

test('registration racing initial evidence persistence cannot be overwritten by an older empty intent', async () => {
  const initial = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  const writes: NativeStopEvidence[] = []
  let first = true
  const f = fixture(false, { save: async value => {
    if (first) { first = false; entered.resolve(); await initial.promise }
    writes.push(structuredClone(value))
  } })
  f.setDispose(async () => { f.settled(true) })
  await f.runtime.open(f.identity, request)
  const stopping = f.runtime.stop('work', 'exec')
  await entered.promise
  f.registered('job')
  initial.resolve()
  assert.deepEqual(await stopping, { status: 'stopped' })
  assert.deepEqual(writes.map(value => [value.phase, value.jobs]), [
    ['stopping', []], ['stopping', ['job']], ['stopping', []], ['disposed', []],
  ])
})

test('pending opening cancellation reaches exact native creation before its serialized open settles', async () => {
  const entered = Promise.withResolvers<void>()
  let received: AbortSignal | undefined
  const gateway = { create: async (request: { signal?: AbortSignal }) => {
    received = request.signal; entered.resolve()
    await new Promise<void>((_resolve, reject) => request.signal?.addEventListener('abort', () => reject(request.signal!.reason), { once: true }))
    throw new Error('unreachable')
  } } as unknown as DshAgentGateway
  const runtime = new NativeExecutions({} as Context, gateway, {} as ExecutionObservations)
  const identity: WorkIdentity = { workId: 'opening-work', executionId: 'opening-exec', role: 'Worker' }
  const opening = runtime.open(identity, request).catch(error => error)
  await entered.promise
  const stopped = (runtime as any).cancelOpening(identity.workId, identity.executionId)
  assert.equal(received?.aborted, true, 'abort cannot queue behind the pending open')
  const result = await stopped
  await opening
  assert.equal(result.status, 'unconfirmed', 'plain native rejection is not teardown confirmation')
  await assert.rejects(runtime.open({ ...identity, executionId: 'replacement' }, request), /confirm|creation/i)
})

test('confirmed opening cancellation persists identity and blocks replacement until acknowledgement', async () => {
  const { DshAgentCreationCancelled } = await import('../src/adapters/dsh/host-types.js')
  const entered = Promise.withResolvers<void>(), confirming = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let calls = 0, signal: AbortSignal | undefined
  const evidence: NativeStopEvidence[] = []
  const gateway = { create: async (input: { signal?: AbortSignal }) => {
    calls++; signal = input.signal; entered.resolve()
    await new Promise<void>((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(new DshAgentCreationCancelled(true, input.signal!.reason, 'unpublished; resource diagnostic retained')), { once: true }))
    throw new Error('unreachable')
  } } as unknown as DshAgentGateway
  const runtime = new NativeExecutions({} as Context, gateway, {} as ExecutionObservations, { save: async row => {
    evidence.push(row); if (row.phase === 'disposed') { confirming.resolve(); await release.promise }
  } })
  const identity: WorkIdentity = { workId: 'owned-open', executionId: 'owned-exec', role: 'Worker' }
  const opening = runtime.open(identity, request).catch(error => error)
  await entered.promise
  assert.deepEqual(await runtime.cancelOpening(identity.workId, 'other-exec'), { status: 'superseded' })
  assert.equal(signal!.aborted, false)
  const reason = new Error('Helper cancellation identity'), stop = runtime.cancelOpening(identity.workId, identity.executionId, reason)
  await confirming.promise
  const error = await opening; assert.equal(error.cause, reason)
  await assert.rejects(runtime.open({ ...identity, executionId: 'replacement' }, request), /confirm/)
  assert.equal(calls, 1)
  release.resolve(); assert.deepEqual(await stop, { status: 'stopped' })
  assert.deepEqual(evidence.map(row => row.phase), ['stopping', 'disposed'])
  assert.match(evidence[1]!.reason!, /resource diagnostic/)
})

// Real Cordis lifecycle, adapter boundary producer: final history remains
// authoritative even when root unload has already removed every event listener.
for (const reported of [true, false, undefined] as const) test(`root unload does not register new effects; producer evidence ${reported}`, async () => {
  const ctx = new Context(), writes: NativeStopEvidence[] = []
  const f = fixture(true, { save: async row => { writes.push(structuredClone(row)) } }, ctx)
  f.setDispose(async () => {
    assert.equal(writes[0]?.phase, 'stopping')
    if (reported !== undefined) f.settled(reported)
    f.clearJobs()
  })
  await f.runtime.open(f.identity, request)
  let result: Awaited<ReturnType<NativeExecutions['stop']>> | undefined
  ctx.effect(() => async () => { result = await f.runtime.stop('work', 'exec') })
  await ctx.fiber.dispose()
  assert.equal(result?.status, reported === true ? 'stopped' : 'unconfirmed')
  assert.equal(writes.at(-1)?.phase, reported === true ? 'disposed' : 'stopping')
})
test('root unload late job history cannot be mistaken for an empty stopped registry', async () => {
  const ctx = new Context(), f = fixture(false, undefined, ctx)
  f.setDispose(async () => { f.registered('late-job'); f.clearJobs() })
  await f.runtime.open(f.identity, request)
  let result: Awaited<ReturnType<NativeExecutions['stop']>> | undefined
  ctx.effect(() => async () => { result = await f.runtime.stop('work', 'exec') })
  await ctx.fiber.dispose()
  assert.equal(result?.status, 'unconfirmed')
  if (result?.status === 'unconfirmed') assert.deepEqual(result.jobs, ['late-job'])
})
