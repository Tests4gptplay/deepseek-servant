import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Agents, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { DshAgentGateway } from '../src/adapters/dsh/agents.js'
import type { DshAgentRole } from '../src/adapters/dsh/host-types.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { ReasoningEffortId, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse } from './fixtures/official-mock-adapter.js'

for (const role of ['foreground', 'organizer', 'planner', 'worker', 'recorder', 'helper'] as DshAgentRole[]) {
  for (const explicit of [false, true]) test(`native ${role} prompt resolves ${explicit ? 'explicit' : 'Auto'} model before request admission`, async t => {
    const ctx = new Context()
    t.after(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'You are a coding agent powered by the {{model}} model.' })
    await ctx.plugin(Tools)
    await ctx.plugin(Agents)
    const defaults = await ctx.plugin(AgentDefaultModel, { provider: 'unconfigured-provider', model: 'default-test-model' })
    await ctx.plugin(AgentLoop, { agents: [] })
    const gateway = new DshAgentGateway(ctx)
    const owned = await gateway.create({ sessionId: `native-${role}-${explicit}`, cwd: process.cwd(), role,
      ...(explicit ? { model: { provider: 'explicit-provider', model: 'explicit-test-model', maxTokens: 1234 } } : {}),
    })
    t.after(async () => { await owned.dispose() })
    const agent = owned.actualAgent
    assert.equal(agent.options.provider, explicit ? 'explicit-provider' : 'unconfigured-provider')
    assert.equal(agent.options.model, explicit ? 'explicit-test-model' : 'default-test-model')
    if (explicit) assert.equal(agent.options.maxTokens, 1234)
    const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent))
    assert.ok(renderPrompt(assembly).includes(explicit ? 'explicit-test-model' : 'default-test-model'))
    await owned.send('Check native request admission without a configured provider.', `input-${role}-${explicit}`)
    await owned.whenIdle()
    const failure = owned.observe().error?.message
    assert.ok(failure, 'The intentionally unconfigured provider must report a native error')
    assert.doesNotMatch(failure, /prompt variable|has no provider\/model/)
    assert.match(failure, /provider|adapter/i)
    if (role === 'foreground' && !explicit) {
      await defaults.dispose()
      await ctx.plugin(AgentDefaultModel, { provider: 'changed-provider', model: 'changed-test-model' })
      const later = await gateway.create({ sessionId: 'later-default-selection', cwd: process.cwd(), role })
      t.after(async () => { await later.dispose() })
      assert.equal(later.actualAgent.options.model, 'changed-test-model')
      assert.ok(renderPrompt(await agent.ctx.systemPrompt.assemble(assembleContextFor(agent))).includes('default-test-model'))
      assert.equal(agent.options.model, 'default-test-model', 'Existing execution keeps its captured default')
    }
  })
}

test('persisted Auto resume keeps admitted A while new Auto uses B and explicit resume selects C', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dss-model-resume-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt, { personaPrefix: 'You are a coding agent powered by the {{model}} model.' })
  await ctx.plugin(Tools)
  await ctx.plugin(Agents)
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
  const defaults = await ctx.plugin(AgentDefaultModel, { provider: 'controlled', model: 'A', reasoningEffort: 'high' })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(Array.from({ length: 5 }, () => textResponse('Controlled response.')),
    { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] }, 2048)
  ctx.llm.registerAdapter(['controlled'], adapter)
  const gateway = new DshAgentGateway(ctx)
  const request = { sessionId: 'persisted-model-selection', cwd: root, role: 'foreground' as const }
  const check = (call: GenerateOptions | undefined, model: string, effort: string | undefined, maxTokens: number) => {
    assert.ok(call)
    assert.equal(call.provider, 'controlled')
    assert.equal(call.model, model)
    assert.equal(call.reasoningEffort, effort)
    assert.equal(call.maxTokens, maxTokens)
    const system = call.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
    assert.ok(system.includes(`powered by the ${model} model.`), system)
  }
  const first = await gateway.create(request)
  await first.send('First Auto request.', 'first-A')
  await first.whenIdle()
  assert.equal(first.observe().error, undefined)
  check(adapter.requests[0], 'A', 'high', 2048)
  await ctx.sessions.flush(first.actualAgent.session)
  assert.equal(first.actualAgent.session.requestHeader()?.config.model, 'A')
  await first.dispose()
  const disk = await ctx.sessionPersistence.open(SessionId(request.sessionId), 'read')
  try {
    assert.ok((await disk.read(0)).events.some(event => event.type === 'request/header' && event.data.header.config.model === 'A'))
  } finally { await disk.close() }
  await defaults.dispose()
  await ctx.plugin(AgentDefaultModel, { provider: 'controlled', model: 'B' })
  const resumed = await gateway.create({ ...request, resume: true })
  await resumed.send('Resume the persisted Auto execution.', 'resume-A')
  await resumed.whenIdle()
  check(adapter.requests[1], 'A', 'high', 2048)
  await resumed.dispose()
  const fresh = await gateway.create({ ...request, sessionId: 'new-Auto-B' })
  await fresh.send('Start a new Auto execution.', 'new-B')
  await fresh.whenIdle()
  check(adapter.requests[2], 'B', undefined, 2048)
  await fresh.dispose()
  const changed = await gateway.create({ ...request, resume: true,
    model: { provider: 'controlled', model: 'C', maxTokens: 1024 } })
  await changed.send('Continue with explicit C.', 'explicit-C')
  await changed.whenIdle()
  check(adapter.requests[3], 'C', undefined, 1024)
  await changed.dispose()
  const cleared = await gateway.create({ ...request, resume: true, model: { provider: 'controlled', model: 'C' } })
  await cleared.send('Use provider token defaults for C.', 'default-C')
  await cleared.whenIdle()
  check(adapter.requests[4], 'C', undefined, 2048)
  await cleared.dispose()
})
