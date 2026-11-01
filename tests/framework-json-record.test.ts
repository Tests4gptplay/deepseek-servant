import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { omitAbsentFields } from '../src/adapters/dsh/json-record.js'

test('native JSON records omit optional object fields without mutating their source', () => {
  const input = { settings: { background: undefined, workerSeats: 2 }, rows: [{ absent: undefined, value: null }] }
  assert.deepEqual(z.json().parse(omitAbsentFields(input)), { settings: { workerSeats: 2 }, rows: [{ value: null }] })
  assert.equal(Object.hasOwn(input.settings, 'background'), true)
})
test('omitting object fields does not silently coerce invalid JSON values', () => {
  for (const value of [undefined, [undefined], NaN, Infinity, new Date(), new Map(), () => 1, { value: NaN }]) {
    assert.throws(() => z.json().parse(omitAbsentFields(value)))
  }
})
test('circular records fail explicitly while repeated non-circular objects remain valid', () => {
  const circular: { self?: unknown } = {}; circular.self = circular
  assert.throws(() => omitAbsentFields(circular), /circular/)
  const shared = { value: 1, absent: undefined }
  assert.deepEqual(z.json().parse(omitAbsentFields([shared, shared])), [{ value: 1 }, { value: 1 }])
})
