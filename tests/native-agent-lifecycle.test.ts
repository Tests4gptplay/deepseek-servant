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
