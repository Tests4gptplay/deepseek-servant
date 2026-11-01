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
