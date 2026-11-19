import assert from 'node:assert/strict'
import { fixture, trace } from './w129/candidate-fixture.mjs'

const f = await fixture('wake-lookup-reuse')
const request = id => ({ id, role: 'Foreground', reason: 'notification', sources: [] })
try {
  const first = request('first')
  const events = (stage, channel) => f.traceEvents.filter(row => row.stage === stage
    && row.command.channel === channel && row.command.op === 'fetchHead').length
  assert.equal(typeof await trace.run('new', () => f.rt.wakeDiscovered(first)), 'function')
  assert.equal(events('new', 'read'), 1, 'Exact miss and alternative scan share one read HEAD')
  assert.equal((await f.records.get(f.key(first))).request.id, first.id)
  const originalList = f.records.listAt.bind(f.records)
  let lists = 0
  f.records.listAt = (...args) => { lists++; return originalList(...args) }
  assert.equal(await trace.run('same', () => f.rt.wakeDiscovered(first)), false)
  assert.equal(events('same', 'read'), 1)
  assert.equal(lists, 0, 'Exact hit must not scan siblings')
  const another = request('another')
  assert.equal(await trace.run('other', () => f.rt.wakeDiscovered(another)), false)
  assert.equal(events('other', 'read'), 1)
  assert.equal(lists, 1, 'Miss still recognizes original pending input')
  assert.equal(await f.records.get(f.key(another)), undefined)
  await f.rt.updateWake(f.key(first), row => ({ ...row, delivered: true }))
  assert.equal(typeof await trace.run('after', () => f.rt.wakeDiscovered(another)), 'function')
  assert.equal((await f.records.get(f.key(another))).request.id, another.id)
  console.log('passed: one discovery HEAD, exact hit avoids list, alternate pending dedup, terminal then new input')
} finally { await f.close() }
