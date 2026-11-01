import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as tick } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import { DshAgentGateway } from '../src/adapters/dsh/agents.js'

async function fixture() {
  let closed = false, cancellations = 0, disposals = 0, sends = 0, flushes = 0
  let flush: () => Promise<void> = async () => {}
  let dispose: () => Promise<void> = async () => {}
  const agent = { id: 'synthetic-worker', status: 'running', ctx: { get: () => undefined },
    inbox: { nextTurn: [], nextStep: [] }, session: { snapshotEvents: () => [], deriveMessages: () => [] },
    cancel: () => { cancellations++ }, followup: () => { sends++ },
    whenIdle: () => new Promise<void>(() => {}), // Durability disposal must not await model completion here.
  }
  const ctx = { get: () => undefined, agents: { get: () => undefined, create: async () => ({ agent,
    dispose: async () => { disposals++; await dispose(); closed = true },
  }) }, sessions: { flush: async () => { flushes++; await flush(); if (closed) throw new Error('flush on closed handle') } } }
  const gateway = new DshAgentGateway(ctx as unknown as Context)
  const handle = await gateway.create({ sessionId: agent.id, role: 'worker', cwd: '/synthetic' })
  return { gateway, handle, setFlush: (fn: typeof flush) => { flush = fn }, setDispose: (fn: typeof dispose) => { dispose = fn },
    counts: () => ({ cancellations, disposals, sends, flushes, closed }) }
}

for (const operation of ['cancel', 'send'] as const) test(`native disposal waits for admitted ${operation} durability and fences later operations`, { timeout: 2000 }, async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.setFlush(async () => { entered.resolve(); await release.promise })
  const active = operation === 'cancel' ? f.handle.cancel() : f.handle.send('work', 'stable-id')
  const activeResult = active.then(() => undefined, error => error)
  await entered.promise
  const disposal = f.handle.dispose(), duplicate = f.handle.dispose(), lateCancel = f.handle.cancel()
  const pending = Promise.allSettled([disposal, duplicate, lateCancel])
  await tick()
  const before = f.counts()
  await assert.rejects(f.handle.send('while closing', 'closing-id'), /disposed|closing/i)
  release.resolve()
  assert.equal(await activeResult, undefined)
  assert.ok((await pending).every(result => result.status === 'fulfilled'))
  assert.equal(before.disposals, 0, 'native close cannot overtake an admitted persistence barrier')
  assert.equal(before.flushes, 1, 'cancel after closing joins teardown instead of entering another flush')
  assert.equal(f.counts().disposals, 1)
  assert.equal(f.handle.observe().state, 'stopped')
  assert.equal(f.gateway.get('synthetic-worker'), undefined)
  await assert.rejects(f.handle.send('late', 'late-id'), /disposed|closing/i)
  await f.handle.cancel(); await f.handle.dispose()
  assert.equal(f.counts().disposals, 1)
})

test('failed admitted flush is preserved while disposal still releases the native owner', { timeout: 2000 }, async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), failure = new Error('synthetic persistence write failed')
  f.setFlush(async () => { entered.resolve(); await release.promise; throw failure })
  const sent = f.handle.send('work', 'stable-id')
  const rejected = assert.rejects(sent, error => error === failure)
  await entered.promise
  const disposal = f.handle.dispose()
  await tick(); const before = f.counts().disposals
  release.resolve()
  await rejected; await disposal
  assert.equal(before, 0)
  assert.equal(f.counts().disposals, 1)
})

test('native disposal failure is shared and preserved, retry does not falsely retire or reopen admission', { timeout: 2000 }, async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), failure = new Error('synthetic close failed')
  f.setDispose(async () => { entered.resolve(); await release.promise; throw failure })
  const first = f.handle.dispose(); await entered.promise
  const second = f.handle.dispose(), cancellation = f.handle.cancel()
  const results = Promise.allSettled([first, second, cancellation])
  release.resolve()
  const settled = await results
  assert.ok(settled.every(result => result.status === 'rejected' && result.reason === failure))
  assert.equal(f.counts().disposals, 1)
  assert.equal(f.counts().flushes, 0)
  assert.equal(f.gateway.get('synthetic-worker'), f.handle)
  assert.notEqual(f.handle.observe().state, 'stopped')
  await assert.rejects(f.handle.send('late', 'late-id'), /disposed|closing/i)
  f.setDispose(async () => {})
  await f.handle.dispose()
  assert.equal(f.counts().disposals, 2)
  assert.equal(f.gateway.get('synthetic-worker'), undefined)
})

async function recoveryFixture() {
  const message = (id: string, text: string) => ({ id, role: 'user', source: { kind: 'deepseek-servant' }, content: [{ type: 'text', text }] })
  const business = message('B', 'business B'), recovery = message('R', 'inspect persisted inputs and continue')
  const events: any[] = [{ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [business, recovery] } }]
  let sends = 0, removals = 0, flush: () => Promise<void> = async () => {}
  const agent: any = { id: 'recovery-native', status: 'idle', ctx: { get: () => undefined },
    inbox: { nextTurn: [business, recovery], nextStep: [], remove: (id: string) => {
      const index = agent.inbox.nextTurn.findIndex((item: any) => item.id === id)
      if (index < 0) return false
      agent.inbox.nextTurn.splice(index, 1); removals++
      events.push({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: index, removedCount: 1, inserted: [], outcome: 'canceled' } })
      return true
    } },
    session: { snapshotEvents: () => events, deriveMessages: () => [] },
    followup: (input: any) => {
      if (agent.inbox.nextTurn.some((item: any) => item.id === input.id)) throw new Error('already pending')
      events.push({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: agent.inbox.nextTurn.length, removedCount: 0, inserted: [input] } })
      agent.inbox.nextTurn.push(input); agent.status = 'running'; sends++
    },
  }
  const ctx: any = { get: () => undefined, agents: { get: () => undefined, create: async () => ({ agent, dispose: async () => {} }) }, sessions: { flush: async () => flush() } }
  const handle = await new DshAgentGateway(ctx).create({ sessionId: agent.id, cwd: '/synthetic', role: 'helper' })
  return { handle, agent, events, business, recovery, counts: () => ({ sends, removals }), setFlush: (fn: typeof flush) => { flush = fn } }
}
test('recovery readmission preserves business input and serializes duplicate recovery requests', async () => {
  const f = await recoveryFixture()
  await Promise.all([f.handle.send(f.recovery.content[0]!.text, 'R', 'followup', 'deepseek-servant', {}),
    f.handle.send(f.recovery.content[0]!.text, 'R', 'followup', 'deepseek-servant', {})])
  assert.deepEqual(f.counts(), { sends: 1, removals: 1 })
  assert.equal(f.agent.inbox.nextTurn[0], f.business)
  assert.deepEqual(f.agent.inbox.nextTurn.map((item: any) => item.id), ['B', 'R'])
})
test('withdrawal flush failure retains the same recovery identity for a later retry', async () => {
  const f = await recoveryFixture()
  f.setFlush(async () => { throw new Error('unknown withdrawal durability') })
  await assert.rejects(f.handle.send(f.recovery.content[0]!.text, 'R', 'followup', 'deepseek-servant', {}), /unknown withdrawal/)
  assert.deepEqual(f.counts(), { sends: 0, removals: 1 })
  f.setFlush(async () => {})
  await f.handle.send(f.recovery.content[0]!.text, 'R', 'followup', 'deepseek-servant', {})
  assert.deepEqual(f.counts(), { sends: 1, removals: 1 })
  assert.deepEqual(f.agent.inbox.nextTurn.map((item: any) => item.id), ['B', 'R'])
})
for (const active of [true, false]) test('claimed recovery input active=' + active + ' is never blindly duplicated', async () => {
  const f = await recoveryFixture()
  f.events.push({ type: 'turn/start', data: { turn: 1 } })
  f.agent.inbox.nextTurn.splice(1, 1)
  f.events.push({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 1, removedCount: 1, inserted: [] } })
  f.agent.status = active ? 'running' : 'idle'
  const send = () => f.handle.send(f.recovery.content[0]!.text, 'R', 'followup', 'deepseek-servant', {})
  if (active) await send()
  else await assert.rejects(send(), /confirmed prior execution stop/)
  assert.deepEqual(f.counts(), { sends: 0, removals: 0 })
})


test('recovery explanation may use waking steer without changing the business inbox', async () => {
  const f = await recoveryFixture()
  let steers = 0
  f.agent.steer = (input: any) => {
    steers++
    f.agent.inbox.nextStep.push(input)
    f.events.push({ type: 'agent/inbox/spliced', data: { target: 'next-step', start: 0, removedCount: 0, inserted: [input] } })
    f.agent.status = 'running'
  }
  const send = () => f.handle.send(f.recovery.content[0]!.text, 'R', 'steer', 'deepseek-servant', {})
  await Promise.all([send(), send()])
  assert.equal(steers, 1)
  assert.deepEqual(f.agent.inbox.nextTurn, [f.business])
  assert.deepEqual(f.agent.inbox.nextStep.map((item: any) => item.id), ['R'])
  assert.equal(f.counts().removals, 1)
})
test('recovery delivery rejects non-waking inject and human source', async () => {
  const f = await recoveryFixture()
  await assert.rejects(f.handle.send('recovery', 'new-R', 'inject', 'deepseek-servant', {}), /Recovery delivery/)
  await assert.rejects(f.handle.send('recovery', 'new-R', 'steer', 'user', {}), /Recovery delivery/)
  assert.deepEqual(f.counts(), { sends: 0, removals: 0 })
})
