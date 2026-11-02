import test, { type TestContext } from 'node:test'
import { AsyncLocalStorage } from 'node:async_hooks'
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
import { withSnapshot } from '../src/framework/transactions.js'
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
async function fixture(t: TestContext, rounds: number, silent = false, interrupted = false, explicitSend?: 'same' | 'different', resetBackground = false, earlyReceipt = false) {
  const root = await mkdtemp(join(tmpdir(), 'dss-current-foreground-'))
  const ctx = new Context(), files = await LocalFiles.open(join(root, 'files'))
  let runtime: FrameworkRoleRuntime | undefined
  let releaseWork!: () => void, workEntered = false, changes = 0, changesBeforeReceipt = 0
  const workBarrier = new Promise<void>(resolve => { releaseWork = resolve })
  const extraDisposers: Array<() => Promise<void>> = []
  t.after(async () => { releaseWork(); try { for (const dispose of extraDisposers) await dispose(); await runtime?.dispose() } finally { await ctx.fiber.dispose(); await files.close(); await rm(root, { recursive: true, force: true }) } })
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(Agents); await ctx.plugin(JobsLocal)
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentDefaultModel, { provider: 'controlled', model: 'foreground-continuity' })
  await ctx.plugin(AgentLoop, { agents: [] })
  let call = 0
  const owners: OwnedDshAgent[] = []
  if (earlyReceipt) {
    await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: 'debug/user-request.txt', content: 'Actual material requested for inspection.' }], 'Inspection fixture'))
    const readBytes = files.readBytes.bind(files)
    files.readBytes = async (snapshot, path) => { if (path === 'debug/user-request.txt') { workEntered = true; await workBarrier } return readBytes(snapshot, path) }
  }
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
    ...(earlyReceipt ? [
      () => { changesBeforeReceipt = changes; return toolCallResponse('receipt-' + round, 'dss_conversation_send', { id: 'receipt-' + round, text: 'I have your request. I will inspect the saved material now.', intent: 'human', replyTo: 'user-' + round }) },
      () => toolCallResponse('snapshot-' + round, 'dss_snapshot', {}),
      (options: any) => {
        const snapshot = options.messages.filter((message: any) => message.role === 'tool').flatMap(texts).flatMap((text: string) => { try { return [JSON.parse(text)] } catch { return [] } }).findLast((value: any) => value.snapshotId)
        assert.ok(snapshot, 'Substantive read uses the actual fixed snapshot tool result')
        return toolCallResponse('inspect-' + round, 'dss_read', { snapshotId: snapshot.snapshotId, path: 'debug/user-request.txt' })
      },
    ] : []),
    ...(explicitSend ? [() => toolCallResponse('conversation-' + (++call), 'dss_conversation_send', { id: 'explicit-answer-' + round, text: answer(round), intent: 'human', replyTo: 'user-' + round })] : []),
    () => textResponse(silent ? '' : answer(round) + (explicitSend === 'different' ? '\nAdditional actual native final.' : '')),
  ]).flat()
  const adapter = new MockAdapter(resetBackground ? [...script.slice(0, 2),
    () => toolCallResponse('reset-snapshot', 'dss_snapshot', {}),
    options => {
      const snapshot = options.messages.filter(message => message.role === 'tool').flatMap(texts).flatMap(text => { try { return [JSON.parse(text)] } catch { return [] } }).findLast(value => value.snapshotId)
      assert.ok(snapshot)
      return toolCallResponse('reset-task', 'dss_submit_task', { snapshotId: snapshot.snapshotId, name: 'independent-background', route: 'P', text: 'Synthetic independent task remains active while conversation reset stops only Foreground.' })
    }, 'hang', 'hang', 'hang'] : interrupted ? [...script.slice(0, 2), 'hang'] : script)
  ctx.llm.registerAdapter(['controlled'], adapter)
  const rows = new Map<string, unknown>(), errors: unknown[] = []
  let heartbeats = 0
  const storage: StoragePort = { get: async key => structuredClone(rows.get(key)) as never, set: async (key, value) => { rows.set(key, structuredClone(value)) }, list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) as never }
  runtime = new FrameworkRoleRuntime(ctx, files, storage, { scope: 'native-foreground', member: 'synthetic-A', primary: true, workspace: root, workerSeats: 0, mode: 'local', collaborationId: 'native-foreground' }, { members: () => ['synthetic-A'], resources: () => [], heartbeat: async () => { heartbeats++ }, error: error => errors.push(error), changed: () => { changes++ } })
  await runtime.start()
  const exchange = async (round: number) => {
    await runtime!.conversation.send('user-' + round, { id: 'user-' + round, participantId: 'synthetic-A', role: 'user', text: question(round), createdAt: new Date(Date.UTC(2026, 10, 1, 0, round)).toISOString(), recipient: 'ai' })
    await runtime!.wake({ id: 'conversation-round-' + round, role: 'Foreground', reason: 'notification', sources: [] })
    await until(() => adapter.requests.length >= (round + 1) * (earlyReceipt ? 6 : explicitSend ? 4 : 3), 'Actual native round must finish its tools and answer')
    const owned = owners[round]!
    assert.ok(owned, 'Actual Foreground owner must exist')
    await owned.whenIdle()
    assert.equal(owned.observe().error, undefined)
    assert.deepEqual(errors, [])
    // The completed Foreground may retire during this fixture durability barrier.
    // The official backend barrier reconciles closed writers without hiding other failures.
    await ctx.sessionPersistence.flush()
    return owned
  }
  return { runtime, adapter, exchange, ctx, storage, root, files, errors, extraDisposers, heartbeats: () => heartbeats, releaseWork, workEntered: () => workEntered, changes: () => changes, changesBeforeReceipt: () => changesBeforeReceipt, owners }
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

for (const outcome of ['confirmed', 'unknown'] as const) test(`Local Foreground reset stops its exact owner before ${outcome} action and replay does not stop a later session or background Task`, async t => {
  const { runtime, ctx, adapter, storage, heartbeats } = await fixture(t, 1, false, false, undefined, true)
  await runtime.conversation.send('user-0', { id: 'user-0', participantId: 'synthetic-A', role: 'user', text: question(0), createdAt: '2026-11-01T00:00:00Z', recipient: 'ai' })
  await runtime.wake({ id: 'reset-original', role: 'Foreground', reason: 'notification', sources: [] })
  await until(() => adapter.requests.length >= 6, 'Actual Foreground and independently submitted Planner must both be in flight')
  const old = runtime.native.get(foregroundWork)!
  const bindings = adapter.requests.map(request => {
    const text = request.messages.filter(message => message.role === 'system').flatMap(texts).join('\n')
    const marker = 'Current role and source locations: '
    return JSON.parse(text.slice(text.indexOf(marker) + marker.length).split('\n')[0]) as { role: string; workId: string; taskId?: string }
  })
  const planner = bindings.find(binding => binding.role === 'Planner')!
  assert.ok(planner?.taskId, 'The background Task must be submitted through actual native tools')
  const background = runtime.native.get(planner.workId)!
  assert.equal(old.observe().state, 'running')
  assert.equal(background.observe().state, 'running')
  await runtime.wake({ id: 'reset-pending-old-recovery', role: 'Foreground', reason: 'startup-recovery', sources: [], context: { facts: 'Synthetic existing continuation queued behind the busy old Foreground.' } })
  const beforeWakes = await storage.list<any>('framework-runtime/')
  assert.ok(beforeWakes.some(row => row.key.includes('/wakes/') && row.value.request?.id === 'reset-pending-old-recovery' && !row.value.delivered))
  let actions = 0
  const reset = () => runtime.withForegroundReset('clear-chat-' + outcome, async () => {
    actions++
    const wakes = await storage.list<any>('framework-runtime/')
    assert.ok(wakes.some(row => row.key.includes('/wakes/') && row.value.request?.id === 'reset-pending-old-recovery' && row.value.delivered), 'Old queued continuation is withdrawn before file action begins')
    assert.equal(ctx.agents.get(old.actualAgent.id), undefined, 'File action cannot begin before the exact old native Foreground is retired')
    const inspection = await new DshSessionReader(ctx).inspect(old.sessionId)
    assert.equal(inspection.liveAgent, false)
    assert.deepEqual(inspection.liveJobIds, [])
    assert.equal(inspection.lastTurn?.reason, 'aborted')
    assert.equal(inspection.lastTurn?.abortCause, 'disposed')
    assert.equal((await runtime.conversation.page(100)).messages.some(message => message.role === 'assistant' && message.text === 'partial'), false, 'Interrupted stream fragments are not a completed assistant reply')
    assert.equal(runtime.native.get(planner.workId), background)
    assert.equal(background.observe().state, 'running', 'Reset cannot stop an unrelated real background Task')
    if (outcome === 'unknown' && actions === 1) throw new Error('Synthetic action outcome unknown; no file deletion asserted')
    return 'action-observed'
  })
  if (outcome === 'unknown') await assert.rejects(reset(), /action outcome unknown/)
  else assert.equal(await reset(), 'action-observed')
  await runtime.conversation.send('user-1', { id: 'user-1', participantId: 'synthetic-A', role: 'user', text: question(1), createdAt: '2026-11-01T00:01:00Z', recipient: 'ai' })
  await runtime.wake({ id: 'reset-later', role: 'Foreground', reason: 'notification', sources: [] })
  if (outcome === 'unknown') {
    assert.ok((await runtime.conversation.page(100)).messages.some(message => message.id === 'user-1' && message.text === question(1)), 'New user input remains durably recorded while cleanup outcome is unresolved')
    const initialHeartbeats = heartbeats()
    await until(() => heartbeats() >= initialHeartbeats + 2, 'Real Host polling must continue while cleanup is unresolved')
    assert.equal(adapter.requests.length, 6, 'No new Foreground may enter before the same cleanup action resolves')
    assert.equal(runtime.native.get(foregroundWork), undefined)
    assert.equal(runtime.native.get(planner.workId), background)
    assert.equal(background.observe().state, 'running', 'Only Foreground admission is held, not background execution')
    const pending = await storage.list<any>('framework-runtime/')
    assert.ok(pending.some(row => row.key.includes('/wakes/') && row.value.request?.id === 'reset-later' && !row.value.delivered))
    assert.equal(await reset(), 'action-observed', 'The original command resolves the pending action before admission resumes')
  }
  await until(() => adapter.requests.length >= 7, 'New post-reset conversation must admit a new native session')
  const later = runtime.native.get(foregroundWork)!
  assert.ok(later)
  assert.notEqual(later.sessionId, old.sessionId)
  assert.equal(later.observe().state, 'running')
  assert.equal(await reset(), 'action-observed')
  assert.equal(actions, outcome === 'unknown' ? 3 : 2, 'The callback retains responsibility for its own stable-command replay')
  assert.equal(runtime.native.get(foregroundWork), later)
  assert.equal(ctx.agents.get(later.actualAgent.id), later.actualAgent)
  assert.equal(later.observe().state, 'running', 'Replayed old reset must not cancel a newly admitted conversation')
  assert.equal(runtime.native.get(planner.workId), background)
  assert.equal(background.observe().state, 'running')
})


test('Foreground persists a natural receipt before substantive native tool work and keeps the final answer in the same exchange', async t => {
  const f = await fixture(t, 2, false, false, undefined, false, true)
  assert.equal(await f.runtime.foregroundProcessing(), undefined, 'Queued input is not a running turn')
  const running = f.exchange(0)
  await until(f.workEntered, 'The actual substantive dss_read must reach its controlled file barrier')
  const messages = (await f.runtime.conversation.page(100)).messages
  const receipt = messages.find(message => message.id === 'receipt-0')
  assert.equal(receipt?.text, 'I have your request. I will inspect the saved material now.')
  assert.equal(receipt?.replyTo, 'user-0')
  assert.equal(messages.filter(message => message.role === 'assistant').length, 1, 'Final answer is not fabricated while the real tool is blocked')
  assert.ok(f.changes() > f.changesBeforeReceipt(), 'The persisted receipt emits the actual runtime changed notification before turn end')
  const processing = await f.runtime.foregroundProcessing()
  assert.ok(processing, 'A persisted receipt and actual native turn expose processing')
  assert.ok(processing.startedAt > 0)
  assert.deepEqual(await f.runtime.foregroundProcessing(), processing, 'Read/refresh preserves the original native start')
  ;(f.runtime as unknown as { foregroundVisibility?: unknown }).foregroundVisibility = undefined
  assert.deepEqual(await f.runtime.foregroundProcessing(), processing, 'Reattached display verifies actual persisted owned output without inventing an ACK')
  const owned = f.owners[0]!
  let idle = false
  void owned.whenIdle().then(() => { idle = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(idle, false, 'The receipt does not terminate Foreground while substantive work remains')
  const prompt = f.adapter.requests[0]!.messages.filter(message => message.role === 'system').flatMap(texts).join('\n')
  assert.match(prompt, /Before substantive work/)
  assert.match(prompt, /dss_conversation_send/)
  assert.match(prompt, /simple question directly/)
  f.releaseWork(); await running
  const toolResults = f.adapter.requests[5]!.messages.filter(message => message.role === 'tool').flatMap(texts)
  assert.ok(toolResults.some(text => text.includes('Actual material requested for inspection.')), 'The substantive tool returns the actual stored material after release')
  await until(async () => (await f.runtime.conversation.page(100)).messages.some(message => message.text === answer(0)), 'Native final follows the early persisted receipt')
  assert.equal(await f.runtime.foregroundProcessing(), undefined, 'Final capture/retirement ends processing')
  const group = (await f.runtime.conversation.recentExchanges())[0]!
  assert.deepEqual(group.assistants.map(message => [message.text, message.replyTo]), [[receipt!.text, 'user-0'], [answer(0), 'user-0']])
  const requestStart = f.adapter.requests.length
  const next = await f.exchange(1)
  assert.notEqual(next.sessionId, owned.sessionId)
  const seed = f.adapter.requests[requestStart]!.messages.filter(message => message.source?.kind === 'deepseek-servant-history').flatMap(texts).join('\n')
  const originals = JSON.parse(seed.slice(seed.indexOf('\n') + 1)) as Array<Array<{ text: string }>>
  assert.equal(originals.length, 1, 'Receipt and final are one complete exchange, not two rounds')
  assert.deepEqual(originals[0]!.map(message => message.text), [question(0), receipt!.text, answer(0)])
  assert.deepEqual(f.errors, [])
})

for (const explicit of [undefined, 'same'] as const) test(`visible final hides processing before completedRound storage ack: ${explicit}`, async t => {
 const f=await fixture(t,1,false,false,explicit,false,true), runtime=f.runtime as any
 const save=runtime.saveRole.bind(runtime)
 let release!:()=>void, held=false
 const gate=new Promise<void>(resolve=>{release=resolve})
 runtime.saveRole=async (record:any,...args:any[])=>{if(record.completedRound){held=true;await gate} return save(record,...args)}
 const running=f.exchange(0)
 try {
  await until(f.workEntered,'actual substantive work')
  assert.ok(await runtime.foregroundProcessing())
  f.releaseWork()
  await until(()=>held,'actual final capture reaches completion persistence')
  assert.ok((await runtime.conversation.page(100)).messages.some((m:any)=>m.text===answer(0)), 'Actual final is already durably visible')
  assert.equal(await runtime.foregroundProcessing(),undefined)
 } finally { release(); f.releaseWork(); await running }
})

for (const explicit of [undefined, 'same'] as const) test(`visible final notifies before completedRound storage ack: ${explicit}`, async t => {
 const f=await fixture(t,1,false,false,explicit,false,true), runtime=f.runtime as any
 const save=runtime.saveRole.bind(runtime)
 let release!:()=>void, held=false
 let atSave = -1, atVerifiedFinal = -1, finalDisplay: unknown
 Object.defineProperty(runtime, 'foregroundFinal', { configurable: true, get: () => finalDisplay, set: value => { finalDisplay = value; atVerifiedFinal = f.changes() } })
 const conversationSend = runtime.conversation.send.bind(runtime.conversation)
 runtime.conversation.send = async (commandId:string,...args:any[]) => { const result = await conversationSend(commandId,...args); if(commandId.startsWith('native-capture/')) atSave = f.changes(); return result }
 const gate=new Promise<void>(resolve=>{release=resolve})
 runtime.saveRole=async (record:any,...args:any[])=>{if(record.completedRound){held=true;await gate} return save(record,...args)}
 const running=f.exchange(0)
 try {
  await until(f.workEntered,'actual substantive work')
  assert.ok(await runtime.foregroundProcessing())
  const beforeFinal = f.changes()
  f.releaseWork()
  await until(()=>held,'actual final capture reaches completion persistence')
  assert.ok((await runtime.conversation.page(100)).messages.some((m:any)=>m.text===answer(0)), 'Actual final is already durably visible')
  assert.equal(await runtime.foregroundProcessing(),undefined)
  console.log('FINAL_NOTIFICATION', { explicit: explicit ?? 'native-capture', beforeFinal, atSave, atVerifiedFinal, afterFinal: f.changes() })
  assert.ok(atVerifiedFinal >= 0 && f.changes() > atVerifiedFinal, 'verified final display completion must notify before lifecycle receipt persistence')
 } finally { release(); f.releaseWork(); await running }
})


test('fixture durability barrier tolerates only native writers closed by completed Foreground retirement', async t => {
  const f = await fixture(t, 1)
  const boundary = new AsyncLocalStorage<boolean>()
  const persistence = f.ctx.sessionPersistence
  const create = persistence.create.bind(persistence), flushBackend = persistence.flush.bind(persistence)
  let gated = false, retiredHandleError = false
  persistence.create = async (...args: Parameters<typeof create>) => {
    const handle = await create(...args), flush = handle.flush.bind(handle)
    handle.flush = async (...options: Parameters<typeof flush>) => {
      if (boundary.getStore() && !gated) {
        gated = true
        await until(() => !f.ctx.agents.get(handle.id), 'The product must naturally retire its completed native owner')
        try { return await flush(...options) } catch (error) {
          retiredHandleError = error instanceof Error && error.name === 'SessionHandleClosedError'
          throw error
        }
      }
      return flush(...options)
    }
    return handle
  }
  persistence.flush = (...args: Parameters<typeof flushBackend>) => boundary.run(true, () => flushBackend(...args))
  const owned = await f.exchange(0)
  assert.equal(gated, true, 'The fixture barrier must overlap the actual writer retirement')
  assert.equal(retiredHandleError, true, 'The unchanged native handle rejects its post-close flush')
  assert.equal(f.ctx.agents.get(owned.actualAgent.id), undefined)
  const events = await new DshSessionReader(f.ctx).events(owned.sessionId)
  assert.ok(events.some(event => event.type === 'turn/end'), 'Cold native history retains its completed turn')
  const messages = (await f.runtime.conversation.page(100)).messages
  assert.deepEqual(messages.filter(message => message.role === 'assistant').map(message => [message.text, message.replyTo]), [[answer(0), 'user-0']])
  assert.deepEqual(f.errors, [])
})

test('fixture backend durability barrier still reports an actual non-retirement writer failure', async t => {
  const f = await fixture(t, 1, false, false, undefined, false, true)
  const persistence = f.ctx.sessionPersistence, create = persistence.create.bind(persistence)
  const failure = new Error('Synthetic native writer durability failure')
  const boundary = new AsyncLocalStorage<boolean>()
  let inject = false
  persistence.create = async (...args: Parameters<typeof create>) => {
    const handle = await create(...args), flush = handle.flush.bind(handle)
    handle.flush = (...options: Parameters<typeof flush>) => inject && boundary.getStore() ? Promise.reject(failure) : flush(...options)
    return handle
  }
  const running = f.exchange(0)
  try {
    await until(f.workEntered, 'The real Foreground tool must remain in flight during the backend barrier')
    inject = true
    await assert.rejects(boundary.run(true, () => persistence.flush()), error => error instanceof AggregateError && error.errors.includes(failure))
  } finally { inject = false; f.releaseWork() }
  await running
  await until(async () => (await f.runtime.conversation.page(100)).messages.some(message => message.text === answer(0)), 'The unchanged final answer remains durable after the controlled writer fault ends')
  assert.deepEqual(f.errors, [])
})
