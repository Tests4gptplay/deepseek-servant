import test from 'node:test'
import assert from 'node:assert/strict'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, SessionLogOffset, SessionSeq, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { ensureForegroundActivity, foregroundActivityProjectionKey } from '../src/adapters/dsh/foreground-activity.js'

// Actual installed official Session/Projection/Cordis, no model request or storage substitute.
const settled = () => new Promise<void>(resolve => setImmediate(resolve))
async function fixture(t: test.TestContext) {
  const ctx = new Context()
  const sessions = await ctx.plugin(SessionStore), projections = await ctx.plugin(SessionProjectionRegistry)
  const reader = ensureForegroundActivity(ctx)
  await settled()
  t.after(async () => { await reader.dispose(); await projections.dispose(); await sessions.dispose(); await ctx.fiber.dispose() })
  return { ctx, reader, session: ctx.get('sessions')!.create() }
}

test('real committed turn boundaries preserve start metadata and never cache message bodies', async t => {
  const { reader, session } = await fixture(t)
  assert.equal(reader.available(), true)
  assert.equal(reader.read(session), null)
  const start = session.append('turn/start', { turn: 1 })
  assert.deepEqual(reader.read(session), { turn: 1, startSeq: start.seq, startedAt: start.time })
  const before = reader.read(session)
  session.append('step/start', { turn: 1, step: 1 })
  assert.strictEqual(reader.read(session), before, 'unrelated events cause no downstream state churn')
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(reader.read(session), { turn: 1, startSeq: start.seq, startedAt: start.time, end: 'completed' })
  assert.deepEqual(Object.keys(reader.read(session)!).sort(), ['end', 'startSeq', 'startedAt', 'turn'])
})

for (const reason of [{ kind: 'aborted', reason: { kind: 'user' } }, { kind: 'error', error: { message: 'failure', code: 'UNKNOWN' } },
  { kind: 'interrupted' }, { kind: 'blocked' }, { kind: 'max-tokens' }, { kind: 'forked' }] satisfies TurnEndReason[]) {
  test(`official ${reason.kind} termination is not completion`, async t => {
    const { reader, session } = await fixture(t)
    const start = session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason })
    assert.equal(reader.read(session)?.end, reason.kind)
    const next = session.append('turn/start', { turn: 2 })
    assert.deepEqual(reader.read(session), { turn: 2, startSeq: next.seq, startedAt: next.time })
    assert.notEqual(next.seq, start.seq)
  })
}

test('official cold hydrate reconstructs the original timestamp without eventAt/snapshotEvents', async t => {
  const { ctx, reader, session } = await fixture(t)
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: SessionSeq(0), time: 123456, data: { turn: 7 } },
    { type: 'turn/end', seq: SessionSeq(1), time: 123789, data: { turn: 7, reason: { kind: 'interrupted' } } },
  ]
  const id = SessionId('cold-activity')
  const cold = Session.create(id, events, { ...session.header, id }, SessionLogOffset(0))
  const registry = ctx.get('sessionProjections')!
  registry.hydrate(cold, {}, events, SessionLogOffset(0))
  assert.deepEqual(reader.read(cold), { turn: 7, startSeq: 0, startedAt: 123456, end: 'interrupted' })
  const checkpoint = registry.restore({}, events, SessionLogOffset(0), cold.header, cold.inheritedEventCount).checkpoint
  assert.deepEqual(checkpoint[foregroundActivityProjectionKey]?.val, reader.read(cold))
  assert.ok(!JSON.stringify(checkpoint).includes('message'))
})

test('native registration reference counting retains other runtime and owner disposal removes last reader', async t => {
  const { ctx, reader, session } = await fixture(t)
  const second = ensureForegroundActivity(ctx)
  await settled()
  const start = session.append('turn/start', { turn: 1 })
  await reader.dispose()
  assert.equal(reader.read(session), undefined)
  assert.equal(second.read(session)?.startedAt, start.time)
  await second.dispose()
  assert.equal(ctx.get('sessionProjections')!.stateOf(session, foregroundActivityProjectionKey), undefined)
})

test('late official projection capability is supported and ctx ownership disposes registration', async () => {
  const ctx = new Context(), sessions = await ctx.plugin(SessionStore)
  const reader = ensureForegroundActivity(ctx)
  assert.equal(reader.available(), false)
  const projections = await ctx.plugin(SessionProjectionRegistry)
  await settled()
  assert.equal(reader.available(), true)
  await projections.dispose()
  await settled()
  assert.equal(reader.available(), false)
  await reader.dispose(); await sessions.dispose(); await ctx.fiber.dispose()
})


test('real model messages including interrupted prefixes neither imply finality nor store text', async t => {
  const { reader, session } = await fixture(t)
  session.append('turn/start', { turn: 1 })
  const before = reader.read(session)
  for (const interrupted of [false, true]) session.append('assistant/message', {
    turn: 1, step: 1, stream: [], ...(interrupted ? { interrupted: true as const } : {}),
    message: createAssistantMessage({ content: [{ type: 'text', text: 'Visible private text must not enter this projection' }],
      source: { provider: 'test-provider', model: 'test-model' } }),
  }, { surfaceOp: 'append' })
  assert.strictEqual(reader.read(session), before)
  assert.equal(reader.read(session)?.end, undefined)
  assert.ok(!JSON.stringify(reader.read(session)).includes('Visible'))
})

test('disposing the caller fiber automatically releases its shared native registration', async t => {
  const { ctx, reader, session } = await fixture(t)
  let owned: ReturnType<typeof ensureForegroundActivity> | undefined
  const owner = await ctx.plugin(scope => { owned = ensureForegroundActivity(scope) })
  await settled()
  session.append('turn/start', { turn: 1 })
  assert.equal(owned?.available(), true)
  await owner.dispose()
  assert.equal(owned?.available(), false)
  assert.equal(reader.read(session)?.turn, 1, 'other runtime retains its registration')
})
