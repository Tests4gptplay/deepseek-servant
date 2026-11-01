import test from 'node:test'
import assert from 'node:assert/strict'
import { disposeResources } from '../src/framework/dispose-resources.js'

test('Host resource disposal attempts service and storage after transport fails', async () => {
  const calls: string[] = [], error = new Error('transport release failed')
  await assert.rejects(disposeResources([
    () => { calls.push('transport'); throw error },
    async () => { calls.push('service') },
    async () => { calls.push('storage') },
  ]), (value: unknown) => value instanceof AggregateError && value.errors.length === 1 && value.errors[0] === error)
  assert.deepEqual(calls, ['transport', 'service', 'storage'])
})
test('Host disposal preserves every original failure while completing all releases', async () => {
  const first = new Error('native stop not confirmed'), second = new Error('storage close failed')
  await assert.rejects(disposeResources([() => {}, async () => { throw first }, () => { throw second }]),
    (value: unknown) => value instanceof AggregateError && value.errors[0] === first && value.errors[1] === second)
})
test('storage cannot close before asynchronous service cleanup has settled', async () => {
  const calls: string[] = []
  let release!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const pending = disposeResources([
    () => { calls.push('transport') },
    async () => { calls.push('service-start'); entered(); await new Promise<void>(resolve => { release = resolve }); calls.push('service-end') },
    () => { calls.push('storage') },
  ])
  await started
  assert.deepEqual(calls, ['transport', 'service-start'])
  release(); await pending
  assert.deepEqual(calls, ['transport', 'service-start', 'service-end', 'storage'])
})
