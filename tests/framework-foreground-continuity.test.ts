import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Agents from '@deepseek-ai/dsh-agent'
import JobsLocal from '@deepseek-ai/dsh-jobs-local'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { StoragePort } from '../src/contracts/ports.js'
import { FrameworkRoleRuntime } from '../src/framework/role-runtime.js'
import { LocalFiles } from '../src/framework/local-files.js'
import { DshSessionReader } from '../src/adapters/dsh/sessions.js'
import type { OwnedDshAgent } from '../src/adapters/dsh/host-types.js'
import { MockAdapter, textResponse, toolCallResponse } from './fixtures/official-mock-adapter.js'

const foregroundWork = JSON.stringify(['Foreground', null, null, null])
const question = (round: number) => `Original question ${round}\n  preserve spaces  中文🙂`
const answer = (round: number) => `Complete answer ${round}\nsecond line  保留原文🙂`
const texts = (message: any): string[] => typeof message.content === 'string' ? [message.content] : message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text)

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 8000
  while (!await check()) {
    assert.ok(Date.now() < deadline, label)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
async function fixture(t: TestContext, rounds: number, silent = false, interrupted = false, explicitSend?: 'same' | 'different') {
  const root = await mkdtemp(join(tmpdir(), 'dss-current-foreground-'))
  const ctx = new Context(), files = await LocalFiles.open(join(root, 'files'))
  let runtime: FrameworkRoleRuntime | undefined
  const extraDisposers: Array<() => Promise<void>> = []
  t.after(async () => { try { for (const dispose of extraDisposers) await dispose(); await runtime?.dispose() } finally { await ctx.fiber.dispose(); await files.close(); await rm(root, { recursive: true, force: true }) } })
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(Agents); await ctx.plugin(JobsLocal)
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentDefaultModel, { provider: 'controlled', model: 'foreground-continuity' })
  await ctx.plugin(AgentLoop, { agents: [] })
  let call = 0
  const owners: OwnedDshAgent[] = []
  const script = Array.from({ length: rounds }, (_, round) => [
    () => {
      const owner = runtime!.native.get(foregroundWork)
      assert.ok(owner, 'Actual native request belongs to an admitted Foreground owner')
      owners[round] = owner
      return toolCallResponse('conversation-' + (++call), 'dss_conversation_read', { mode: 'pending' })
    },
    (options: any) => {
      const pending = options.messages.filter((message: any) => message.role === 'tool').flatMap(texts).flatMap((text: string) => { try { return [JSON.parse(text)] } catch { return [] } }).findLast((value: any) => Array.isArray(value.messages) && value.revision)
      assert.ok(pending, 'Actual pending conversation must be read before claim')
      assert.ok(pending.messages.some((message: any) => message.id === 'user-' + round && message.text === question(round)))
      return toolCallResponse('conversation-' + (++call), 'dss_conversation_claim', { expectedRevision: pending.revision, messageIds: pending.messages.map((message: any) => message.id), list: 'Read original question ' + round, cache: 'Current conversation responsibility ' + round })
    },
    ...(explicitSend ? [() => toolCallResponse('conversation-' + (++call), 'dss_conversation_send', { id: 'explicit-answer-' + round, text: answer(round), intent: 'human', replyTo: 'user-' + round })] : []),
    () => textResponse(silent ? '' : answer(round) + (explicitSend === 'different' ? '\nAdditional actual native final.' : '')),
  ]).flat()
  const adapter = new MockAdapter(interrupted ? [...script.slice(0, 2), 'hang'] : script)
  ctx.llm.registerAdapter(['controlled'], adapter)
  const rows = new Map<string, unknown>(), errors: unknown[] = []
  const storage: StoragePort = { get: async key => structuredClone(rows.get(key)) as never, set: async (key, value) => { rows.set(key, structuredClone(value)) }, list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) as never }
  runtime = new FrameworkRoleRuntime(ctx, files, storage, { scope: 'native-foreground', member: 'synthetic-A', primary: true, workspace: root, workerSeats: 0, mode: 'local', collaborationId: 'native-foreground' }, { members: () => ['synthetic-A'], resources: () => [], heartbeat: async () => {}, error: error => errors.push(error) })
  await runtime.start()
  const exchange = async (round: number) => {
    await runtime!.conversation.send('user-' + round, { id: 'user-' + round, participantId: 'synthetic-A', role: 'user', text: question(round), createdAt: new Date(Date.UTC(2026, 10, 1, 0, round)).toISOString(), recipient: 'ai' })
    await runtime!.wake({ id: 'conversation-round-' + round, role: 'Foreground', reason: 'notification', sources: [] })
    await until(() => adapter.requests.length >= (round + 1) * (explicitSend ? 4 : 3), 'Actual native round must finish its tools and answer')
    const owned = owners[round]!
    assert.ok(owned, 'Actual Foreground owner must exist')
    await owned.whenIdle()
    assert.equal(owned.observe().error, undefined)
    assert.deepEqual(errors, [])
    await ctx.sessions.flush(owned.actualAgent.session)
    return owned
  }
  return { runtime, adapter, exchange, ctx, storage, root, files, errors, extraDisposers }
}

test('current native Foreground finishes two interactions in separate sessions and records actual answers', async t => {
  const { runtime, exchange } = await fixture(t, 2)
  const first = await exchange(0)
  const second = await exchange(1)
  assert.notEqual(second.sessionId, first.sessionId, 'A completed conversation must not reuse the prior native session')
  await until(async () => (await runtime.conversation.page(100)).messages.filter(message => message.role === 'assistant').length === 2, 'Native final answers must reach shared conversation')
  const messages = (await runtime.conversation.page(100)).messages
  for (let round = 0; round < 2; round++) {
    assert.equal(messages.find(message => message.id === 'user-' + round)?.text, question(round))
    assert.ok(messages.some(message => message.role === 'assistant' && message.text === answer(round) && message.replyTo === 'user-' + round))
  }
})

test('nine current native conversations use nine sessions and seed only the last six exact complete exchanges', async t => {
  const { runtime, adapter, exchange } = await fixture(t, 9)
  const sessions: string[] = []
  for (let round = 0; round < 9; round++) {
    const requestStart = adapter.requests.length
    const owned = await exchange(round)
    sessions.push(owned.sessionId)
    await until(async () => (await runtime.conversation.page(100)).messages.some(message => message.role === 'assistant' && message.text === answer(round)), 'Completed native answer must be saved before the next interaction')
    const seedMessages = adapter.requests[requestStart]!.messages.filter(message => message.source?.kind === 'deepseek-servant-history')
    assert.equal(seedMessages.length, round ? 1 : 0, 'Each new native session receives at most one original-history seed')
    if (round) {
      const seedText = texts(seedMessages[0]).join('\n')
      const originals = JSON.parse(seedText.slice(seedText.indexOf('\n') + 1)) as Array<Array<{ id: string; text: string; role: string }>>
      assert.equal(originals.length, Math.min(6, round))
      for (let index = 0; index < originals.length; index++) {
        const prior = Math.max(0, round - 6) + index
        assert.deepEqual(originals[index]!.map(message => [message.role, message.text]), [['user', question(prior)], ['assistant', answer(prior)]])
      }
    }
  }
  assert.equal(new Set(sessions).size, 9)
  const history = (await runtime.conversation.page(100)).messages
  assert.equal(history.length, 18)
  for (let round = 0; round < 9; round++) {
    assert.equal(history.filter(message => message.text === question(round)).length, 1)
    assert.equal(history.filter(message => message.text === answer(round)).length, 1)
  }
})

test('normally completed silent native turns do not fabricate assistant exchanges', async t => {
  const { runtime, exchange } = await fixture(t, 2, true)
  const first = await exchange(0)
  const second = await exchange(1)
  assert.notEqual(first.sessionId, second.sessionId)
  const history = (await runtime.conversation.page(100)).messages
  assert.equal(history.filter(message => message.role === 'assistant').length, 0)
  assert.deepEqual(await runtime.conversation.recentExchanges(), [])
  assert.deepEqual(history.filter(message => message.role === 'user').map(message => message.text), [question(0), question(1)])
})

test('cold native continuation of an unfinished claimed Foreground retains its original session', async t => {
  const original = await fixture(t, 1, false, true)
  await original.runtime.conversation.send('user-0', { id: 'user-0', participantId: 'synthetic-A', role: 'user', text: question(0), createdAt: '2026-11-01T00:00:00Z', recipient: 'ai' })
  await original.runtime.wake({ id: 'interrupted-input', role: 'Foreground', reason: 'notification', sources: [] })
  await until(() => original.adapter.requests.length === 3, 'Native response must be in flight after the actual claim')
  const old = original.runtime.native.get(foregroundWork)!
  assert.ok(old)
  assert.equal((await original.runtime.conversation.pendingForeground()).messages.length, 0)
  await original.runtime.dispose()
  const stoppedInspection = await new DshSessionReader(original.ctx).inspect(old.sessionId)
  await original.ctx.fiber.dispose()
  const ctx = new Context()
  let resumed: FrameworkRoleRuntime | undefined
  original.extraDisposers.push(async () => { await resumed?.dispose(); await ctx.fiber.dispose() })
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(Agents); await ctx.plugin(JobsLocal)
  await ctx.plugin(JsonlPersistence, { root: join(original.root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentDefaultModel, { provider: 'controlled', model: 'foreground-continuity' })
  await ctx.plugin(AgentLoop, { agents: [] })
  let resumedOwner: OwnedDshAgent | undefined
  const adapter = new MockAdapter(Array.from({ length: 8 }, () => options => {
    if (options.messages.filter(message => message.role === 'system').flatMap(texts).join('\n').includes('\"role\":\"Foreground\"')) resumedOwner = resumed!.native.get(foregroundWork)
    return textResponse('Continued original interrupted responsibility.')
  }))
  ctx.llm.registerAdapter(['controlled'], adapter)
  const errors: unknown[] = []
  resumed = new FrameworkRoleRuntime(ctx, original.files, original.storage, { scope: 'native-foreground', member: 'synthetic-A', primary: true, workspace: original.root, workerSeats: 0, mode: 'local', collaborationId: 'native-foreground' }, { members: () => ['synthetic-A'], resources: () => [], heartbeat: async () => {}, error: error => errors.push(error) })
  await resumed.start()
  await until(() => { assert.deepEqual(errors, []); return !!resumedOwner }, 'Persisted incomplete Foreground must resume without new user input: ' + JSON.stringify(stoppedInspection))
  const current = resumedOwner!
  await current.whenIdle()
  assert.equal(current.sessionId, old.sessionId, 'Unfinished responsibility resumes its native history, unlike a new completed exchange')
  assert.notEqual(current, old)
  assert.equal(current.observe().error, undefined)
  assert.deepEqual(errors, [])
  const recoveredReads = adapter.requests.flatMap(request => request.messages.filter(message => message.role === 'tool').flatMap(texts)).flatMap(text => { try { return [JSON.parse(text)] } catch { return [] } })
  assert.ok(recoveredReads.some(value => value.messages?.some((message: any) => message.id === 'user-0' && message.text === question(0))), 'Actual original conversation read must remain verbatim in recovered native context')
})

for (const mode of ['same', 'different'] as const) test(`real Foreground send plus ${mode} native final preserves the exact authoritative answer group`, async t => {
  const { runtime, adapter, exchange } = await fixture(t, 2, false, false, mode)
  const first = await exchange(0)
  const expected = mode === 'same' ? [answer(0)] : [answer(0), answer(0) + '\nAdditional actual native final.']
  await until(async () => (await runtime.conversation.page(100)).messages.filter(message => message.role === 'assistant').length === expected.length, 'Actual successful send and native final must settle without duplicates or lost content')
  const initial = (await runtime.conversation.page(100)).messages.filter(message => message.role === 'assistant')
  assert.deepEqual(initial.map(message => message.text), expected)
  assert.equal(initial[0]!.id, 'explicit-answer-0', 'A duplicate final must not replace the original tool-send identity')
  assert.ok(initial.every(message => message.replyTo === 'user-0'))
  const groups = await runtime.conversation.recentExchanges()
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0]!.assistants.map(message => message.text), expected)
  const requestStart = adapter.requests.length
  const second = await exchange(1)
  assert.notEqual(first.sessionId, second.sessionId)
  const seeds = adapter.requests[requestStart]!.messages.filter(message => message.source?.kind === 'deepseek-servant-history')
  assert.equal(seeds.length, 1)
  const seedText = texts(seeds[0]).join('\n')
  const originals = JSON.parse(seedText.slice(seedText.indexOf('\n') + 1)) as Array<Array<{ text: string; role: string }>>
  assert.deepEqual(originals.map(group => group.map(message => [message.role, message.text])), [[['user', question(0)], ...expected.map(text => ['assistant', text])]])
})
