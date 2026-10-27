import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { Id, roleCommandSchema } from '../src/experimental/private-git/protocol.js'

test('role tool schemas omit the provider-rejected identity regex while retaining host validation', () => {
  for (const role of ['foreground', 'planner', 'worker'] as const) {
    const schema = z.toJSONSchema(z.object({ operation: roleCommandSchema(role) }), { target: 'draft-7' })
    assert.ok(!JSON.stringify(schema).includes('"pattern"'))
    assert.equal(schema.type, 'object')
  }
  for (const id of ['task-1', '工作记录', 'a.b', '__proto__-safe', 'with spaces']) assert.equal(Id.parse(id), id)
  for (const id of ['', '.', '..', '__proto__', 'prototype', 'constructor', 'a/b', 'a\\b', 'a\0b', 'a\rb', 'a\nb']) {
    assert.equal(Id.safeParse(id).success, false, JSON.stringify(id))
    assert.equal(roleCommandSchema('foreground').safeParse({ op: 'join', taskId: id, scope: 'bounded work' }).success, false)
  }
})
