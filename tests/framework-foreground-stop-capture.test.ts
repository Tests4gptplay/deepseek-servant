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
import { FrameworkService } from '../src/framework/service.js'
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
    await ctx.sessions.flush(owned.actualAgent.session)
    return owned
  }
  return { runtime, adapter, exchange, ctx, storage, root, files, errors, extraDisposers, heartbeats: () => heartbeats, releaseWork, workEntered: () => workEntered, changes: () => changes, changesBeforeReceipt: () => changesBeforeReceipt, owners }
}

// The fixture above uses the official Agent, tool runtime and JSONL Session store.
// Only the producer stop timing and model responses below are controlled.
for (const outcome of ['confirmed', 'closing', 'failure'] as const) test(`owned stop defers native final capture until its exact settlement: ${outcome}`, async t => {
  const f = await fixture(t, 1, false, false, undefined, false, true)
  await f.runtime.conversation.send('user-0', { id: 'user-0', participantId: 'synthetic-A', role: 'user', text: question(0), createdAt: '2026-11-01T00:00:00Z', recipient: 'ai' })
  await f.runtime.wake({ id: 'final-race-input', role: 'Foreground', reason: 'notification', sources: [] })
  await until(f.workEntered, 'Original substantive read starts')
  const runtime = f.runtime as any
  const original = f.runtime.native.get(foregroundWork)!, record = runtime.roleRecords.get(foregroundWork)
  const stop = f.runtime.native.stop.bind(f.runtime.native), capture = DshSessionReader.prototype.capture
  const failure = new Error('Controlled exact producer stop failure')
  let entered = false, settled = false, released = false, release!: () => void, captures = 0, premature = 0
  const barrier = new Promise<void>(resolve => { release = () => { released = true; resolve() } })
  t.after(() => release())
  f.runtime.native.stop = async (...args: Parameters<typeof stop>) => {
    entered = true
    await barrier
    try { if (outcome === 'failure') throw failure; return await stop(...args) }
    finally { settled = true }
  }
  t.mock.method(DshSessionReader.prototype, 'capture', async function(this: DshSessionReader, id: string) {
    if (id === original.sessionId && entered) { captures++; if (!settled) premature++ }
    return capture.call(this, id)
  })
  let stopError: unknown
  const stopping = f.runtime.requestExecutionStop('final-race-stop', foregroundWork, record.identity.executionId).catch(error => { stopError = error })
  let disposing: Promise<void> | undefined
  try {
    await until(() => entered, 'Actual exact stop operation is pending')
    f.releaseWork()
    await until(() => f.adapter.requests.length >= 6, 'Actual provider emits final after the substantive tool')
    await original.whenIdle()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(premature, 0, 'No live-session capture races an owned pending stop')
    if (outcome === 'confirmed') {
      // Discover a real Task source while the original exact producer is held.
      // Its native Planner must be admitted, not merely an unrelated JS callback.
      ;(f.adapter as unknown as { script: unknown[] }).script.push('hang')
      await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: 'tasks/independent_P.md', content: 'Independent task admitted while Foreground producer stop is pending.' }], 'Independent task fixture'))
      await until(() => f.adapter.requests.slice(6).some(request => request.messages.filter(message => message.role === 'system').flatMap(texts).some(text => text.includes('"role":"Planner"'))), 'Another actual native Task must be admitted before Foreground stop settles')
      assert.equal(settled, false)
    }
    if (outcome === 'closing') disposing = f.runtime.dispose()
    release(); await stopping
    if (disposing) await disposing
    if (outcome === 'confirmed') {
      await until(async () => (await f.runtime.conversation.page(100)).messages.some(message => message.text === answer(0)), 'Completed native final is captured without another input')
      const assistants = (await f.runtime.conversation.page(100)).messages.filter(message => message.role === 'assistant')
      assert.deepEqual(assistants.map(message => [message.text, message.replyTo]), [['I have your request. I will inspect the saved material now.', 'user-0'], [answer(0), 'user-0']])
      assert.ok(captures > 0)
      assert.deepEqual(f.errors, [])
    } else {
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(captures, 0, 'Closed Host or failed producer stop does not acquire a fresh capture')
      if (outcome === 'failure') {
        assert.ok(stopError instanceof AggregateError && stopError.errors.includes(failure), 'Caller receives the original stop failure')
        assert.ok(f.errors.includes(failure), 'Original producer failure is preserved, not swallowed or replaced')
        const ownedStop = runtime.stopOperations.get(JSON.stringify([foregroundWork, record.identity.executionId]))
        assert.equal(ownedStop.failure, failure)
        assert.notEqual(ownedStop.result?.status, 'stopped')
      }
    }
  } finally {
    if (!released) release()
    f.releaseWork()
    f.runtime.native.stop = stop
    await stopping
    if (disposing) await disposing
  }
})

for (const failure of ['error', 'explicit-stop'] as const) test('same-profile new human input after native ' + failure + ' reaches a persisted reply', async t => {
  const f = await fixture(t, 1, false, true)
  const script = (f.adapter as any).script as any[]
  if (failure === 'error') script[2] = () => { throw new Error('Controlled original Foreground provider error') }
  let followupRequests = 0
  script.push(...Array.from({ length: 30 }, () => (options: any) => {
    const prompt = options.messages.filter((m: any) => m.role === 'system').flatMap(texts).join('\n')
    if (!prompt.includes('"role":"Foreground"')) return textResponse('Controlled Helper diagnostic turn; no automatic restore requested.')
    const step = followupRequests++
    if (step === 0) return toolCallResponse('new-read', 'dss_conversation_read', { mode: 'pending' })
    if (step === 1) {
      const pending = options.messages.filter((m: any) => m.role === 'tool').flatMap(texts).flatMap((text: string) => { try { return [JSON.parse(text)] } catch { return [] } }).findLast((v: any) => Array.isArray(v.messages) && v.revision)
      assert.ok(pending?.messages.some((m: any) => m.id === 'new-human'))
      return toolCallResponse('new-claim', 'dss_conversation_claim', { expectedRevision: pending.revision, messageIds: ['new-human'], list: 'New explicit user request', cache: 'Do not restart the cancelled old request.' })
    }
    if (step === 2) return toolCallResponse('new-reply', 'dss_conversation_send', { id: 'new-ack', text: 'I see the new request and will check it.', intent: 'human', replyTo: 'new-human' })
    return textResponse('New request complete.')
  }))
  await f.runtime.conversation.send('user-0', { id: 'user-0', participantId: 'synthetic-A', role: 'user', text: question(0), createdAt: '2026-11-01T00:00:00Z', recipient: 'ai' })
  await f.runtime.wake({ id: 'original-' + failure, role: 'Foreground', reason: 'notification', sources: [] })
  await until(() => f.adapter.requests.length >= 3, 'Original request reaches native error or cancellation point')
  const original = f.runtime.native.get(foregroundWork)!
  if (failure === 'error') await original.whenIdle()
  else await f.runtime.requestExecutionStop('explicit-stop', foregroundWork, (f.runtime as any).roleRecords.get(foregroundWork).identity.executionId)
  const service = new FrameworkService(f.ctx, f.storage, {} as any), internal = service as any
  internal.saved.set('local',{revision:'native-test',settings:{name:'DSS',userName:'synthetic-A',localDirectory:join(f.root,'files'),ownerRepo:'',repositoryDirectory:'',collaborationId:'native-foreground',workerSeats:0,workspace:f.root}})
  internal.accesses.set('local',Promise.resolve({connection:{files:f.files,transactions:f.runtime.transactions,scope:'native-foreground',identity:{login:'synthetic-A',owner:'synthetic-A',instanceUUID:'00000000-0000-4000-8000-000000000001',repositoryId:'native-foreground'},prepareWrite:async()=>{},close:async()=>{}},conversation:f.runtime.conversation}))
  const access=internal.access.bind(internal);internal.access=(mode:string)=>{assert.equal(mode,'local');assert.ok(internal.accesses.has(mode));return access(mode)}
  await service.send({mode:'local',storageScope:'native-foreground',collaborationId:'native-foreground',id:'new-human',text:'This is a new authorized request, not resume of the old request.',createdAt:'2026-11-01T00:01:00Z',recipient:'ai',device:'audit',timezoneOffsetMinutes:0})
  // New input is discovered from the real durable Foreground signal; no manual runtime wake.
  await until(async () => !!await f.runtime.conversation.read('new-ack'), 'New input on the same profile receives its own reply after ' + failure)
  const current = f.runtime.native.get(foregroundWork); await current?.whenIdle()
  assert.equal((await f.runtime.conversation.read('new-ack'))?.replyTo, 'new-human')
  if(failure==='explicit-stop') assert.deepEqual(f.errors.map(String),[],'explicit confirmed stop must not manufacture a closed-session capture fault')
})

