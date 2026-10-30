import test from 'node:test'
import assert from 'node:assert/strict'
import { subscribeEventStreams } from '../src/client/event-streams.js'

class Stream extends EventTarget {
  readyState = 0
  closes = 0
  constructor(readonly url: URL) { super() }
  close() { this.closes++; this.readyState = 2 }
  emit(type: string) { if (type === 'open') this.readyState = 1; this.dispatchEvent(new Event(type)) }
}
function fixture() {
  Object.defineProperty(globalThis, 'document', { value: { baseURI: 'http://localhost:5173/' }, configurable: true })
  const streams: Stream[] = [], resets = new Set<() => void>()
  let notifications = 0
  const watch = (paths = ['api/deepseek-servant/events', 'api/deepseek-servant-mode/events']) => subscribeEventStreams(paths, () => notifications++, fn => {
    resets.add(fn); return () => { resets.delete(fn) }
  }, url => { const value = new Stream(url); streams.push(value); return value as unknown as EventSource })
  return { streams, resets, watch, count: () => notifications, reset: () => { for (const fn of resets) fn() } }
}
for (const state of [0, 1, 2]) test(`official generation reset replaces SSE in readyState=${state} with the same paths/listeners`, () => {
  const f = fixture(), stop = f.watch()
  f.streams.forEach(stream => { stream.readyState = state })
  f.reset()
  assert.equal(f.streams.length, 4)
  assert.deepEqual(f.streams.slice(0, 2).map(s => s.closes), [1, 1])
  assert.deepEqual(f.streams.slice(2).map(s => s.url.href), f.streams.slice(0, 2).map(s => s.url.href))
  const count = f.count()
  f.streams[0].emit('changed'); f.streams[1].emit('open')
  assert.equal(f.count(), count, 'old event callbacks cannot invalidate current generation')
  f.streams[2].emit('open'); f.streams[2].emit('changed'); f.streams[3].emit('changed')
  assert.equal(f.count(), count + 3)
  stop()
})
test('ordinary SSE reconnect and terminal error do not create a separate retry loop', () => {
  const f = fixture(), stop = f.watch()
  f.streams[0].readyState = 0; f.streams[0].emit('error'); f.streams[0].emit('open')
  f.streams[1].readyState = 2; f.streams[1].emit('error')
  assert.equal(f.streams.length, 2); assert.equal(f.count(), 1)
  f.reset(); assert.equal(f.streams.length, 4)
  stop()
})
test('repeated official resets keep exactly one stream per path and one reset subscription', () => {
  const f = fixture(), stop = f.watch()
  for (let i = 0; i < 5; i++) {
    f.reset()
    assert.equal(f.resets.size, 1)
    assert.equal(f.streams.filter(s => s.closes === 0).length, 2)
  }
  stop(); stop()
  assert.equal(f.resets.size, 0); assert(f.streams.every(s => s.closes === 1))
  const count = f.count(); f.reset(); f.streams.at(-1)!.emit('changed')
  assert.equal(f.count(), count)
})
test('inactive subscriptions stay stopped across reset and remount starts clean streams', () => {
  const f = fixture(), stop = f.watch()
  stop(); f.reset(); assert.equal(f.streams.length, 2)
  const stopNew = f.watch(); assert.equal(f.streams.length, 4)
  f.streams[0].emit('changed'); assert.equal(f.count(), 0)
  f.streams[2].emit('changed'); assert.equal(f.count(), 1)
  stopNew()
})
test('mode and shared view subscriptions have independent ownership without stream leaks', () => {
  const f = fixture(), stopShared = f.watch(), stopMode = f.watch(['api/deepseek-servant-mode/events'])
  assert.equal(f.streams.length, 3); f.reset()
  assert.equal(f.streams.length, 6); assert.equal(f.streams.filter(s => !s.closes).length, 3)
  stopShared(); assert.equal(f.streams.filter(s => !s.closes).length, 1)
  f.reset(); assert.equal(f.streams.filter(s => !s.closes).length, 1)
  stopMode(); assert(f.streams.every(s => s.closes === 1))
})
