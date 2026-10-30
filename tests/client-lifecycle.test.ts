import test from 'node:test'
import assert from 'node:assert/strict'
import { createServantSource, type ServantClientApi, type ServantNotice } from '../src/client/source.js'
import { createRequestLifecycle, lifecycleRequest } from '../src/client/request-lifecycle.js'
import { ModeClient } from '../src/mode-router/client.js'
import type { ServantView } from '../src/contracts/views.js'

const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const page = (id = 'loaded') => ({ assistant: { id: 'default' }, tasks: [], messages: [{ id, role: 'assistant', text: id }] }) as ServantView
function fixture(overrides: Partial<ServantClientApi> = {}) {
  let changed = () => {}, reset = () => {}, disposed = 0
  const notices: Array<Omit<ServantNotice, 'sequence'>> = []
  const api = { view: async () => page(), retention: async () => ({ totalBytes: 0 }), send: async () => ({ status: 'queued' }),
    subscribeChanged: (fn: () => void) => { changed = fn; return () => { disposed++ } }, subscribeReset: (fn: () => void) => { reset = fn; return () => { disposed++ } },
    ...overrides } as ServantClientApi
  const source = createServantSource(api, notice => notices.push(notice))
  const unsubscribe = source.source.subscribe(() => {})
  return { source, unsubscribe, notices, changed: () => changed(), reset: () => reset(), disposed: () => disposed }
}

test('send ACK clears pending without waiting for a stalled refresh; reset after ACK never resends', async () => {
  const stalled = deferred<ServantView>(), signals: AbortSignal[] = []
  let reads = 0, sends = 0
  const f = fixture({ view: async (_input, signal) => { signals.push(signal!); return ++reads === 1 ? page() : stalled.promise }, send: async () => { sends++; return { status: 'queued' } } })
  await tick()
  assert.equal(await f.source.send('stable', 'hello'), true)
  assert.equal(sends, 1); assert.deepEqual(f.source.source.getSnapshot().pending, [])
  assert.equal(f.source.source.getSnapshot().status, 'loading')
  assert.equal(f.notices.at(-1)?.key, 'sent')
  f.reset(); await tick()
  assert.equal(signals[1].aborted, true); assert.equal(sends, 1)
  assert.equal(f.notices.some(n => n.key === 'interrupted'), false, 'ACKed send is not reported uncertain')
  f.source.dispose()
})

test('refresh rejection after send ACK is a read error, never a failed send', async () => {
  let reads = 0
  const f = fixture({ view: async () => { if (++reads > 1) throw new Error('read unavailable'); return page() } })
  await tick()
  assert.equal(await f.source.send('stable', 'hello'), true)
  await tick()
  assert.equal(f.source.source.getSnapshot().error, 'read unavailable')
  assert.deepEqual(f.notices.map(n => n.key), ['sent'])
  f.source.dispose()
})

test('reset before ACK settles unknown send, preserves caller identity for explicit retry, ignores late old receipt', async () => {
  const first = deferred<unknown>(), second = deferred<unknown>(), calls: Array<{ messageId: string; signal: AbortSignal }> = []
  const f = fixture({ send: async (input, signal) => { calls.push({ messageId: input.messageId, signal: signal! }); return calls.length === 1 ? first.promise : second.promise } })
  await tick()
  const old = f.source.send('same-draft', 'hello')
  f.reset()
  assert.equal(await old, false); assert.equal(calls[0].signal.aborted, true)
  assert.deepEqual(f.source.source.getSnapshot().pending, [])
  await tick(); assert.equal(calls.length, 1, 'connection reset does not replay')
  const current = f.source.send('same-draft', 'hello')
  first.resolve({ status: 'queued' }); await tick()
  assert.deepEqual(f.source.source.getSnapshot().pending, ['send'], 'old finally cannot clear a newer send')
  assert.deepEqual(f.notices.map(n => n.key), ['interrupted'])
  second.resolve({ status: 'queued' }); assert.equal(await current, true)
  assert.deepEqual(calls.map(c => c.messageId), ['same-draft', 'same-draft'])
  assert.deepEqual(f.notices.map(n => n.key), ['interrupted', 'sent'])
  f.source.dispose()
})

test('transport failure releases pending so the next explicit send can succeed', async () => {
  let calls = 0
  const f = fixture({ send: async () => { if (++calls === 1) throw new Error('disconnected'); return { status: 'queued' } } })
  await tick()
  assert.equal(await f.source.send('same', 'hello'), false)
  assert.deepEqual(f.source.source.getSnapshot().pending, [])
  assert.equal(await f.source.send('same', 'hello'), true)
  assert.deepEqual(f.notices.map(n => n.key), ['failed', 'sent'])
  f.source.dispose()
})

test('rapid invalidations coalesce behind one read and perform a latest dirty read', async () => {
  const reads: ReturnType<typeof deferred<ServantView>>[] = []
  let stats = 0
  const f = fixture({ view: () => { const value = deferred<ServantView>(); reads.push(value); return value.promise }, retention: async () => { stats++; return { totalBytes: stats } } })
  for (let i = 0; i < 10; i++) { f.changed(); await tick() }
  assert.equal(reads.length, 1); assert.equal(stats, 1)
  reads[0].resolve(page('old')); await tick()
  assert.equal(reads.length, 2); assert.equal(stats, 2)
  assert.equal(f.source.source.getSnapshot().value?.messages[0].id, 'old', 'same-query valid progress remains visible while dirty tail catches up')
  reads[1].resolve(page('latest')); await tick()
  assert.equal(f.source.source.getSnapshot().value?.messages[0].id, 'latest')
  assert.equal(reads.length, 2)
  f.source.dispose()
})

test('reset cancels stalled view/stats and fresh reads complete without their responses', async () => {
  const stale = deferred<ServantView>(), signals: AbortSignal[] = []
  let reads = 0
  const f = fixture({ view: async (_input, signal) => { signals.push(signal!); return ++reads === 1 ? stale.promise : page('new') } })
  f.reset(); await tick()
  assert.equal(signals[0].aborted, true)
  assert.equal(f.source.source.getSnapshot().value?.messages[0].id, 'new')
  stale.resolve(page('late')); await tick()
  assert.equal(f.source.source.getSnapshot().value?.messages[0].id, 'new')
  f.source.dispose()
})

test('disposed source settles pending and subscriptions without issuing task controls or accepting late projection', async () => {
  const pending = deferred<unknown>()
  let controls = 0
  const f = fixture({ send: () => pending.promise, control: async () => { controls++ } })
  await tick()
  const sent = f.source.send('same', 'hello')
  f.source.dispose(); assert.equal(await sent, false)
  pending.resolve({ status: 'queued' }); await tick()
  assert.deepEqual(f.source.source.getSnapshot().pending, [])
  assert.deepEqual(f.notices, []); assert.equal(f.disposed(), 2); assert.equal(controls, 0)
  assert.equal(await f.source.send('other', 'no'), false)
})

test('late maintenance result after reset cannot mutate current retention view or publish success', async () => {
  const pending = deferred<unknown>()
  const f = fixture({ retention: async input => input.action === 'stats' ? { totalBytes: 1 } : pending.promise })
  await tick()
  const operation = f.source.retention({ action: 'preview' })
  f.reset(); assert.equal(await operation, false)
  pending.resolve({ previewId: 'obsolete', totals: {} }); await tick()
  assert.equal(f.source.source.getSnapshot().retention, undefined)
  assert.deepEqual(f.notices.map(n => n.key), ['interrupted'])
  f.source.dispose()
})

test('native request lifecycle aborts before reset callbacks; carrier ignoring abort cannot strand callers', async () => {
  const lifecycle = createRequestLifecycle(), pending = deferred<string>()
  let signal!: AbortSignal, started = 0
  const old = lifecycle.request(undefined, active => { started++; signal = active; return pending.promise })
  lifecycle.subscribeReset(() => assert.equal(signal.aborted, true))
  lifecycle.reset()
  await assert.rejects(old, /lifecycle ended/)
  assert.equal(await lifecycle.request(undefined, async active => { assert.equal(active.aborted, false); started++; return 'fresh' }), 'fresh')
  pending.resolve('late'); await tick(); assert.equal(started, 2)
  lifecycle.dispose()
  await assert.rejects(lifecycle.request(undefined, async () => { started++; return 'bad' }), /lifecycle ended/)
  assert.equal(started, 2)
})

test('caller cancellation reaches transport; undefined rejection and pre-abort are not false successes', async () => {
  const scope = new AbortController(), pending = deferred<string>()
  let signal!: AbortSignal, calls = 0
  const old = lifecycleRequest([scope.signal], active => { signal = active; calls++; return pending.promise })
  scope.abort(new Error('navigation'))
  await assert.rejects(old, /navigation/); assert.equal(signal.aborted, true)
  await assert.rejects(lifecycleRequest([scope.signal], async () => { calls++; return 'bad' }), /navigation/)
  assert.equal(calls, 1)
  let rejected = false
  await lifecycleRequest([], () => Promise.reject(undefined)).then(() => assert.fail('undefined rejection became success'), () => { rejected = true })
  assert.equal(rejected, true)
  pending.reject(new Error('late carrier failure')); await tick()
})

test('mode refresh also recovers from obsolete stalled RPC after the shared reset, without duplicate selection', async () => {
  const lifecycle = createRequestLifecycle(), old = deferred<unknown>()
  let calls = 0
  const mode = new ModeClient(() => lifecycle.request(undefined, async () => ++calls === 1 ? old.promise : { activeMode: 'LOCAL' }), lifecycle.subscribeReset)
  mode.subscribe(() => {})
  lifecycle.reset(); await tick()
  assert.equal(calls, 2); assert.equal(mode.snapshot().ready, true); assert.equal(mode.snapshot().error, undefined)
  old.resolve({ activeMode: 'PRIVATE_GIT_EXPERIMENTAL' }); await tick()
  assert.equal(mode.snapshot().activeMode, 'LOCAL')
  mode.dispose(); lifecycle.dispose()
})

test('installed native RPC receives lifecycle AbortSignal and preserves the application messageId across explicit retry', async () => {
  const { installConnection } = await import('@deepseek-ai/dsh-client-connection/client')
  let connection!: import('@deepseek-ai/dsh-client-connection/client').ConnectionHandle
  const payloads: Array<{ payload: { method: string; params: { messageId: string } }; rpcId: string }> = []
  const signals: AbortSignal[] = []
  const stalled = deferred<Response>()
  installConnection({ provide: (_name: string, value: typeof connection) => { connection = value } } as never, { transport: { fetch: async (_url, init) => {
    const wire = JSON.parse(String(init?.body)); payloads.push(wire); signals.push(init!.signal as AbortSignal)
    if (payloads.length === 1) return stalled.promise
    return new Response(JSON.stringify({ type: 'server-response', rpcId: wire.rpcId, result: { ok: true, value: { status: 'queued' } } }), { headers: { 'content-type': 'application/json' } })
  } } })
  const lifecycle = createRequestLifecycle()
  const send = () => lifecycle.request(undefined, signal => connection.rpc.call('/api', 'deepseek-servant-mode/shared', { method: 'send', params: { messageId: 'stable-native-id', text: 'fixture' } }, signal))
  const old = send(); lifecycle.reset(); await assert.rejects(old, /lifecycle ended/)
  assert.equal(signals[0].aborted, true)
  assert.deepEqual(await send(), { ok: true, value: { status: 'queued' } })
  assert.deepEqual(payloads.map(p => p.payload.params.messageId), ['stable-native-id', 'stable-native-id'])
  assert.notEqual(payloads[0].rpcId, payloads[1].rpcId, 'wire correlation is distinct from durable application idempotency')
  stalled.resolve(new Response('late')); await tick()
  lifecycle.dispose()
})


test('sustained same-query invalidations show progress on every completed read with one in flight', async () => {
  const reads: ReturnType<typeof deferred<ServantView>>[] = [], progress: string[] = []
  let active = 0, maximum = 0
  const f = fixture({ view: async () => { active++; maximum = Math.max(maximum, active); const d = deferred<ServantView>(); reads.push(d); try { return await d.promise } finally { active-- } } })
  f.source.source.subscribe(() => { const id = f.source.source.getSnapshot().value?.messages[0].id; if (id && progress.at(-1) !== id) progress.push(id) })
  for (let i = 0; i < 8; i++) {
    f.changed(); await tick()
    assert.equal(reads.length, i + 1)
    reads[i].resolve(page('progress-' + i)); await tick()
    assert.equal(f.source.source.getSnapshot().value?.messages[0].id, 'progress-' + i)
  }
  reads[8].resolve(page('final')); await tick()
  assert.deepEqual(progress, [...Array.from({ length: 8 }, (_, i) => 'progress-' + i), 'final'])
  assert.equal(maximum, 1); assert.equal(active, 0)
  assert.equal(f.source.source.getSnapshot().status, 'ready')
  f.source.dispose()
})

test('reset while no view listeners remain settles old mutation and remount starts fresh', async () => {
  const old = deferred<unknown>()
  const f = fixture({ send: () => old.promise })
  await tick()
  const sent = f.source.send('same-draft', 'hello')
  f.unsubscribe()
  assert.equal(f.disposed(), 1, 'page SSE observer is released; reset belongs to source lifetime')
  f.reset(); assert.equal(await sent, false)
  assert.deepEqual(f.source.source.getSnapshot().pending, [])
  const stop = f.source.source.subscribe(() => {})
  await tick()
  assert.equal(f.source.source.getSnapshot().status, 'ready')
  old.resolve({ status: 'queued' }); await tick()
  assert.deepEqual(f.notices.map(n => n.key), ['interrupted'])
  assert.deepEqual(f.source.source.getSnapshot().pending, [])
  stop(); f.source.dispose()
  assert.equal(f.disposed(), 3, 'each page subscription and the one retained reset subscription release exactly once')
})

test('Git uncommitted and committed-but-unread receipts retain the same draft identity and expose their errors', async () => {
  const calls: string[] = []
  const replies = [
    { state: 'PENDING_UNCOMMITTED', error: 'Push unavailable' },
    { state: 'COMMITTED_PENDING_READ', commit: 'real-commit', error: 'Fetch unavailable' },
    { state: 'CONFIRMED', commit: 'real-commit' },
  ]
  const f = fixture({ send: async input => { calls.push(input.messageId); return replies.shift() } })
  await tick()
  assert.equal(await f.source.send('stable', 'hello'), false)
  assert.equal(f.notices.at(-1)?.detail, 'Push unavailable')
  assert.equal(await f.source.send('stable', 'hello'), false)
  assert.equal(f.notices.at(-1)?.key, 'committedPendingRead')
  assert.equal(f.notices.at(-1)?.detail, 'Fetch unavailable')
  assert.equal(await f.source.send('stable', 'hello'), true)
  assert.deepEqual(calls, ['stable', 'stable', 'stable'])
  assert.deepEqual(f.source.source.getSnapshot().pending, [])
  assert.deepEqual(f.notices.map(n => n.key), ['failed', 'committedPendingRead', 'sent'])
  f.source.dispose()
})
