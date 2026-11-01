import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import ToolRuntime, { jsonSchemaToTs, jsonSchemaToPy } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { installFrameworkRoleTools, type FrameworkRoleBinding, type FrameworkRoleServices } from '../src/framework/role-tools.js'

// Real installed official Cordis, ToolRuntime and model-facing schemas() projection.
// Service bodies are deliberately unavailable: this suite tests registration/schema
// contracts, not business execution, a provider request or a complete Host model turn.
const unavailable = async (): Promise<never> => { throw new Error('Schema test must not execute business services.') }
const services = {
  files: {}, transact: unavailable, notifications: unavailable, afterRecoveryConsumed: unavailable,
  onError: (error: unknown) => { throw error },
  conversation: { foregroundRoot: 'assistants/collaborations/local/schema', read: unavailable, send: unavailable, claim: unavailable },
  artifacts: { preserve: unavailable }, capacity: unavailable,
  helper: { request: unavailable, restore: unavailable, restoreHost: unavailable, healthyCycle: unavailable },
} as unknown as FrameworkRoleServices
const roles = ['Foreground', 'Organizer', 'Planner', 'Worker', 'Recorder', 'Helper'] as const

for (const role of roles) test(`official ToolRuntime registers and projects ${role} schemas without legacy provider-rejected patterns`, async () => {
  const ctx = new Context(), plugins = [await ctx.plugin(SystemPrompt), await ctx.plugin(ToolRuntime)]
  const agent = { id: 'schema-' + role, session: {} } as Agent, scope = createScope(ctx, agent)
  try {
    const binding: FrameworkRoleBinding = { role, workId: role, executionId: 'schema-execution', owner: 'A',
      ...(['Planner', 'Worker', 'Recorder'].includes(role) ? { taskId: 'task-1' } : {}),
      ...(['Planner', 'Worker'].includes(role) ? { member: 'A' } : {}),
    }
    await scope.ctx.inject(['tools', 'systemPrompt'], ready => { installFrameworkRoleTools(ready, agent, binding, services) })
    const schemas = ctx.get('tools')!.schemas(agent)
    assert.ok(schemas.length > 0)
    assert.ok(schemas.some(schema => schema.name === 'dss_snapshot'))
    const expected = {
      Foreground: ['dss_conversation_read', 'dss_conversation_send', 'dss_conversation_claim', 'dss_submit_direct'],
      Organizer: ['dss_member_dispatch', 'dss_complete'], Planner: ['dss_worker_assign', 'dss_complete'],
      Worker: ['dss_worker_deliver'], Recorder: ['dss_recorder_capacity', 'dss_recorder_save'],
      Helper: ['dss_restore', 'dss_restore_host', 'dss_healthy_cycle'],
    }[role]
    for (const name of expected) assert.ok(schemas.some(schema => schema.name === name), 'role branch is actually registered: ' + name)
    assert.ok(schemas.some(schema => schema.name === 'dss_preserve_artifact'), 'optional artifact service is covered')
    assert.deepEqual(ctx.get('tools')!.schemas(), [], 'Agent tools do not leak globally')
    assert.deepEqual(ctx.get('tools')!.schemas({}), [], 'Agent tools do not leak to another Agent')
    for (const schema of schemas) {
      assert.equal(typeof jsonSchemaToTs(schema.parameters), 'string')
      assert.ok(jsonSchemaToPy(schema.parameters), 'official SDK schema conversion')
      // Raw input parameters are NOT restricted by the structured-output subset.
      // ToolRuntime.register validates output.schema; schemas() checks lossless JSON.
      assert.equal(schema.parameters.type, 'object', role + '/' + schema.name)
      assert.deepEqual(Object.keys(schema).sort(), ['description', 'name', 'parameters'])
      assert.ok(!JSON.stringify(schema.parameters).includes('"pattern"'), 'retain old provider identity-regex regression: ' + schema.name)
      assert.ok(!JSON.stringify(schema.parameters).includes('"$schema"'), 'provider projection excludes dialect marker')
      assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema, 'lossless model-facing JSON')
      assert.ok(ctx.get('tools')!.get(schema.name, agent), 'real registry resolves scoped definition')
    }
    const projected = schemas.find(schema => schema.name === 'dss_snapshot')!
    ;(projected.parameters as Record<string, unknown>).description = 'mutated caller projection'
    assert.equal((ctx.get('tools')!.schemas(agent).find(schema => schema.name === 'dss_snapshot')!.parameters as Record<string, unknown>).description, undefined, 'projection is detached from registry')
    const definition = ctx.get('tools')!.get('dss_snapshot_release', agent)!
    await assert.rejects(definition.execute({ snapshotId: 42 }, { agent, callId: 'invalid-schema', signal: new AbortController().signal } as never), /string/)
    await assert.rejects(definition.execute({ snapshotId: 'unused' }, { agent: {} as Agent, callId: 'other-agent', signal: new AbortController().signal } as never), /scoped Agent/)
  } finally {
    await scope.dispose()
    for (const plugin of plugins.reverse()) await plugin.dispose()
  }
})

for (const role of ['Planner', 'Worker'] as const) test(`official ToolRuntime projects ${role} direct-task branch`, async () => {
  const ctx = new Context(), plugins = [await ctx.plugin(SystemPrompt), await ctx.plugin(ToolRuntime)]
  const agent = { id: 'direct-' + role, session: {} } as Agent, scope = createScope(ctx, agent)
  try {
    await scope.ctx.inject(['tools', 'systemPrompt'], ready => { installFrameworkRoleTools(ready, agent, { role, workId: 'direct', executionId: 'exec', owner: 'A', member: 'A',
      direct: { inputPath: 'direct/example.md', signalPath: 'state/Planner_A_Direct_example', resultPath: 'direct/result.md', recipientSignal: 'state/Foreground_Direct' } }, services) })
    const schemas = ctx.get('tools')!.schemas(agent)
    assert.ok(schemas.some(schema => schema.name === 'dss_direct_deliver'))
    assert.ok(!schemas.some(schema => schema.name === 'dss_complete' || schema.name === 'dss_worker_deliver'))
    for (const schema of schemas) {
      assert.equal(schema.parameters.type, 'object')
      assert.equal(typeof jsonSchemaToTs(schema.parameters), 'string')
      assert.ok(jsonSchemaToPy(schema.parameters))
    }
  } finally {
    await scope.dispose()
    for (const plugin of plugins.reverse()) await plugin.dispose()
  }
})
