import test from 'node:test'
import assert from 'node:assert/strict'
import type { StoragePort } from '../src/contracts/ports.js'
import { LocalLocationRegistry, LocalLocationMovedError, LocalLocationOutcomeUnknownError, localLocationRecordKey } from '../src/framework/local-location.js'

function storageFixture() {
  const records = new Map<string, unknown>(), writes: string[] = []
  let fail: 'before' | 'after' | undefined
  const storage: StoragePort = {
    async get<T>(key: string) { return structuredClone(records.get(key)) as T | undefined },
    async set(key, value) {
      writes.push(key)
      if (fail === 'before') { fail = undefined; throw new Error('injected before write') }
      records.set(key, structuredClone(value))
      if (fail === 'after') { fail = undefined; throw new Error('injected lost acknowledgement') }
    },
    async list<T>(prefix: string) { return [...records].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as T })) },
  }
  return { storage, records, writes, fail: (value: 'before' | 'after') => { fail = value } }
}
const identity = { source: '/records/original', target: '/records/moved', scope: JSON.stringify(['local', '/records/original']), fingerprint: 'verified-copy-content-fingerprint' }

test('ordinary opens never generate aliases; only verified publication atomically moves the original scope', async () => {
  const f = storageFixture(), registry = new LocalLocationRegistry(f.storage)
  assert.equal(await registry.resolve(identity.source), identity.scope)
  assert.equal(await registry.resolve(identity.target), JSON.stringify(['local', identity.target]))
  assert.equal(f.writes.length, 0)
  await registry.prepare('move', identity)
  assert.equal(await registry.resolve(identity.source), identity.scope)
  await assert.rejects(registry.resolve(identity.target), /pending explicit move/)
  await assert.rejects(registry.publish('move', { ...identity, fingerprint: 'wrong' }), /match/)
  await registry.publish('move', identity)
  assert.equal(await registry.resolve(identity.target), identity.scope)
  await assert.rejects(registry.resolve(identity.source), LocalLocationMovedError)
  await registry.applied('move')
  const restarted = new LocalLocationRegistry(f.storage)
  assert.equal(await restarted.resolve(identity.target), identity.scope)
  await assert.rejects(restarted.resolve(identity.source), LocalLocationMovedError)
  assert.equal((await restarted.receipt('move'))!.phase, 'applied')
  assert.deepEqual([...new Set(f.writes)], [localLocationRecordKey], 'one record publishes the receipt and both bindings')
})

test('same command cannot change its destination and lost acknowledgements preserve the exact original move', async () => {
  const f = storageFixture(), registry = new LocalLocationRegistry(f.storage)
  f.fail('after')
  await assert.rejects(registry.prepare('move', identity), LocalLocationOutcomeUnknownError)
  const restarted = new LocalLocationRegistry(f.storage)
  assert.equal((await restarted.receipt('move'))!.phase, 'prepared')
  await restarted.prepare('move', identity)
  await assert.rejects(restarted.prepare('move', { ...identity, target: '/elsewhere' }), /reused/)
  f.fail('after')
  await assert.rejects(restarted.publish('move', identity), LocalLocationOutcomeUnknownError)
  assert.equal((await new LocalLocationRegistry(f.storage).receipt('move'))!.phase, 'published')
  assert.equal(await restarted.resolve(identity.target), identity.scope)
  await assert.rejects(restarted.resolve(identity.source), LocalLocationMovedError)
  assert.equal((await restarted.publish('move', identity)).phase, 'published')
  f.fail('after')
  await assert.rejects(restarted.applied('move'), LocalLocationOutcomeUnknownError)
  assert.equal((await restarted.applied('move')).phase, 'applied')
})

test('failed writes do not publish identity and other verified destination scopes are not overwritten', async () => {
  const f = storageFixture(), registry = new LocalLocationRegistry(f.storage)
  await registry.prepare('move', identity)
  f.fail('before')
  await assert.rejects(registry.publish('move', identity), LocalLocationOutcomeUnknownError)
  assert.equal((await registry.receipt('move'))!.phase, 'prepared')
  assert.equal(await registry.resolve(identity.source), identity.scope)
  await registry.publish('move', identity); await registry.applied('move')
  await assert.rejects(registry.prepare('foreign', { source: '/foreign', target: identity.target, scope: JSON.stringify(['local', '/foreign']), fingerprint: 'another' }), /another verified storage/)
  assert.equal(await registry.resolve(identity.target), identity.scope)
})

test('explicit verified return move may reclaim the old empty destination, but ordinary reopen never does', async () => {
  const f = storageFixture(), registry = new LocalLocationRegistry(f.storage)
  await registry.prepare('out', identity); await registry.publish('out', identity); await registry.applied('out')
  await assert.rejects(registry.resolve(identity.source), LocalLocationMovedError)
  // The caller must separately verify an empty target and the actual physical copy.
  const back = { source: identity.target, target: identity.source, scope: identity.scope, fingerprint: 'new-verified-copy' }
  await registry.prepare('back', back); await registry.publish('back', back); await registry.applied('back')
  assert.equal(await registry.resolve(identity.source), identity.scope)
  await assert.rejects(registry.resolve(identity.target), LocalLocationMovedError)
  assert.deepEqual((await registry.receipt('out'))!.target, identity.target)
})

test('two registry objects sharing one owner storage serialize competing moves and leave all unrelated technical records byte-for-byte intact', async () => {
  const f = storageFixture(), a = new LocalLocationRegistry(f.storage), b = new LocalLocationRegistry(f.storage)
  const prior = { operationId: 'unchanged', instanceUUID: 'original', role: { sessionId: 'native-session' }, messageHash: 'same' }
  await f.storage.set('framework/existing-scope-record', prior)
  const outcomes = await Promise.allSettled([a.prepare('one', identity), b.prepare('two', { ...identity, target: '/different' })])
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1)
  assert.deepEqual(await f.storage.get('framework/existing-scope-record'), prior)
  await assert.rejects(a.prepare('wrong-scope', { ...identity, scope: 'invented-scope' }), /source/)
  await assert.rejects(a.resolve('/records/../original'), /canonical/)
})

test('an unproved alias or corrupt receipt fails closed instead of authorizing an arbitrary copied directory', async () => {
  const f = storageFixture(), registry = new LocalLocationRegistry(f.storage)
  await f.storage.set(localLocationRecordKey, { version: 1, moves: [], bindings: {
    [identity.target]: { scope: identity.scope, state: 'current', commandId: 'not-published' },
  } })
  await assert.rejects(registry.resolve(identity.target), /no matching verified publication/)
  await f.storage.set(localLocationRecordKey, { version: 99, moves: [], bindings: {} })
  await assert.rejects(registry.resolve(identity.source), /Invalid/)
})

test('caller mutation of returned receipts cannot change the retained original command', async () => {
  const f = storageFixture(), registry = new LocalLocationRegistry(f.storage)
  const prepared = await registry.prepare('move', identity)
  prepared.target = '/changed-outside'
  const retained = (await registry.receipt('move'))!
  assert.equal(retained.target, identity.target)
  retained.scope = 'changed-outside'
  assert.equal((await registry.receipt('move'))!.scope, identity.scope)
  await registry.publish('move', identity)
  assert.equal(await registry.resolve(identity.target), identity.scope)
})
