import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Id } from '../src/contracts/schemas.js'
import { installRoleTools, type RoleToolsOptions } from '../src/roles/tools.js'

test('local role tools omit provider-rejected identity patterns and validate identities at execution', async () => {
  for (const role of ['foreground', 'planner', 'worker'] as const) {
    const definitions = new Map<string, any>()
    const agent = { id: 'schema-agent', session: { snapshotEvents: () => [] } } as unknown as Agent
    const ctx = { systemPrompt: { section() {} }, tools: { register: (definition: any) => definitions.set(definition.name, definition) } } as unknown as Context
    installRoleTools(ctx, agent, { assistantId: 'default', sessionId: 'schema-agent', role,
      ...(role === 'foreground' ? {} : { taskId: 'task-1', executionId: 'exec-1' }) }, {} as RoleToolsOptions)
    assert.ok(definitions.has('child_reply_read'))
    for (const definition of definitions.values()) {
      assert.equal(definition.parameters.type, 'object', role + '/' + definition.name)
      assert.ok(!JSON.stringify(definition.parameters).includes('?!__proto__'), role + '/' + definition.name)
    }
    for (const taskId of ['__proto__', 'prototype', 'constructor', 'a\0b', 'a\rb', 'a\nb', '']) {
      await assert.rejects(definitions.get('child_reply_read').execute({ taskId }, {
        agent, signal: new AbortController().signal, callId: 'schema-check',
      }))
    }
  }
  for (const id of ['task-1', '工作记录', 'a.b', 'with spaces', '__proto__-safe', 'a/b']) assert.equal(Id.parse(id), id)
  for (const id of ['', '__proto__', 'prototype', 'constructor', 'a\0b', 'a\rb', 'a\nb']) assert.equal(Id.safeParse(id).success, false)
})
