import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { captureForegroundTurns } from '../src/framework/foreground-capture.js'

const event = (type: string, data: unknown, seq: number): SessionEvent => ({ type, data, seq, time: 1_800_000_000_000 + seq,
  ...(['user/message', 'assistant/message', 'tool/result'].includes(type) ? { surfaceOp: 'append' } : {}) }) as SessionEvent
const call = (turn: number, id: string, name: string, args: unknown, seq: number) => event('tool/call', {
  turn, step: 1, callId: id, name, arguments: JSON.stringify(args),
}, seq)
const result = (turn: number, id: string, seq: number, isError = false) => event('tool/result', { turn, step: 1,
  message: { id: 'result-' + seq, role: 'tool', source: { kind: 'tool', callId: id }, toolCallId: id,
    content: [{ type: 'text', text: '{}' }], isError },
}, seq)
const final = (turn: number, id: string, text: string, seq: number, extra: object = {}) => event('assistant/message', {
  turn, step: 2, stream: [], message: { id, role: 'assistant', source: { kind: 'model', provider: 'actual-route', model: 'actual-model' },
    content: [{ type: 'text', text }], ...extra },
}, seq)
const end = (turn: number, seq: number) => event('turn/end', { turn, reason: { kind: 'completed' } }, seq)

test('completed ordinary native answer retains original identity, time, text and actual model metadata without inferring a recipient', () => {
  const original = '  原文\n第二行  '
  const events = [event('user/message', { id: 'wake', role: 'user', source: { kind: 'deepseek-servant' },
    content: [{ type: 'text', text: '{"reason":"notification","recipient":"someone"}' }] }, 1), final(1, 'native-answer', original, 2), end(1, 3)]
  const input = JSON.stringify(events), [captured] = captureForegroundTurns(events)
  assert.deepEqual(captured, { turn: 1, completedAt: 1_800_000_000_003, final: { id: 'native-answer', text: original,
    time: 1_800_000_000_002, at: '2027-01-15T08:00:00.002Z', provider: 'actual-route', model: 'actual-model' }, readMessageIds: [], claimedMessageIds: [], claims: [], sends: [] })
  assert.equal(JSON.stringify(events), input)
  assert.equal('replyTo' in captured!, false)
})

test('successful claims union in order while exact successful send evidence stays separate from final output', () => {
  const events = [call(1, 'c1', 'dss_conversation_claim', { messageIds: ['human-a', 'human-b'] }, 1), result(1, 'c1', 2),
    call(1, 'c2', 'dss_conversation_claim', { messageIds: ['human-b', 'human-c'] }, 3), result(1, 'c2', 4),
    call(1, 's1', 'dss_conversation_send', { id: 'stored-answer', text: 'Same final', intent: 'human', replyTo: 'human-a' }, 5), result(1, 's1', 6),
    final(1, 'native-final', 'Same final', 7), end(1, 8)]
  const [captured] = captureForegroundTurns(events)
  assert.deepEqual(captured!.claimedMessageIds, ['human-a', 'human-b', 'human-c'])
  assert.deepEqual(captured!.claims.map(c => c.messageIds), [['human-a', 'human-b'], ['human-b', 'human-c']])
  assert.deepEqual(captured!.sends, [{ callId: 's1', resultMessageId: 'result-6', time: 1_800_000_000_006,
    id: 'stored-answer', text: 'Same final', intent: 'human', replyTo: 'human-a' }])
  assert.equal(captured!.final!.id, 'native-final')
  assert.equal('replyTo' in captured!, false)
})

test('failed, unmatched, cross-turn and malformed tool calls do not count as successful conversation actions', () => {
  const events = [call(1, 'failed', 'dss_conversation_claim', { messageIds: ['failed'] }, 1), result(1, 'failed', 2, true),
    result(1, 'orphan', 3), call(2, 'other-turn', 'dss_conversation_claim', { messageIds: ['wrong-turn'] }, 4), result(1, 'other-turn', 5),
    call(1, 'ordinary', 'dss_claim', { messageIds: ['not-conversation'] }, 6), result(1, 'ordinary', 7),
    event('tool/call', { turn: 1, step: 1, callId: 'bad-json', name: 'dss_conversation_send', arguments: '{' }, 8), result(1, 'bad-json', 9),
    call(1, 'bad-shape', 'dss_conversation_claim', { messageIds: ['valid', 12] }, 10), result(1, 'bad-shape', 11), end(1, 12)]
  assert.deepEqual(captureForegroundTurns(events), [{ turn: 1, completedAt: 1_800_000_000_012, readMessageIds: [], claimedMessageIds: [], claims: [], sends: [] }])
})

test('only completed turns with final visible non-tool text are captured; reasoning and intermediate tool commentary are excluded', () => {
  const events = [final(1, 'working', 'checking...', 1, { content: [{ type: 'text', text: 'checking...' }, { type: 'tool-call', id: 'x', name: 'read', arguments: '{}' }] }),
    final(1, 'reason', '', 2, { content: [{ type: 'reasoning', text: 'private' }] }), end(1, 3),
    final(2, 'not-finished', 'do not publish', 4), event('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'disposed' } } }, 5),
    final(3, 'pending', 'still running', 6), final(4, 'completed', 'actual final', 7), end(4, 8)]
  const captured = captureForegroundTurns(events)
  assert.deepEqual(captured.map(c => c.turn), [1, 4]); assert.equal(captured[0]!.final, undefined); assert.equal(captured[1]!.final!.text, 'actual final')
})

test('provider replay final selection is reused instead of publishing diagnostic or reasoning text', () => {
  const source = { kind: 'model', provider: 'route', model: 'model', replayState: { response: { kind: 'codex-app-server', items: [
    { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'intermediate' }] },
    { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Exact final' }] },
  ] } } }
  const [capture] = captureForegroundTurns([final(1, 'answer', 'presentation diagnostics', 1, { source }), end(1, 2)])
  assert.equal(capture!.final!.text, 'Exact final')
})

test('separate turns retain independent attribution and repeated success projection is not counted twice', () => {
  const events = [call(1, 'same-id', 'dss_conversation_claim', { messageIds: ['a'] }, 1), result(1, 'same-id', 2), result(1, 'same-id', 3), end(1, 4),
    call(2, 'same-id', 'dss_conversation_send', { id: 'sent-ai', text: 'explicit AI intent', intent: 'ai' }, 5), result(2, 'same-id', 6), final(2, 'different-final', 'Different actual answer', 7), end(2, 8)]
  const captured = captureForegroundTurns(events)
  assert.equal(captured[0]!.claims.length, 1); assert.deepEqual(captured[1]!.claimedMessageIds, [])
  assert.equal(captured[1]!.sends[0]!.intent, 'ai'); assert.equal(captured[1]!.sends[0]!.replyTo, undefined)
  assert.equal(captured[1]!.final!.text, 'Different actual answer')
})


test('successful message/pending/page reads identify actual human records without claiming them or guessing from wake text', () => {
  const readResult = (id: string, value: unknown, seq: number) => {
    const entry = result(1, id, seq) as SessionEvent<'tool/result'>
    entry.data.message.content = [{ type: 'text', text: JSON.stringify(value) }]
    return entry
  }
  const human = { id: 'human-a', role: 'user', text: 'question' }
  const events = [call(1, 'read-a', 'dss_conversation_read', { mode: 'message', reference: human.id }, 1), readResult('read-a', human, 2),
    call(1, 'read-b', 'dss_conversation_read', { mode: 'pending' }, 3), readResult('read-b', { messages: [human, { id: 'human-b', role: 'user', text: 'other' }] }, 4),
    call(1, 'read-c', 'dss_conversation_read', { mode: 'page' }, 5), readResult('read-c', { messages: [{ id: 'assistant', role: 'assistant', text: 'answer' }, { id: 'malformed', role: 'user' }] }, 6),
    call(1, 'memory', 'dss_conversation_read', { mode: 'memory' }, 7), readResult('memory', { messages: [{ id: 'not-human', role: 'user', text: 'not a message list' }] }, 8),
    call(1, 'failed-read', 'dss_conversation_read', { mode: 'pending' }, 9), result(1, 'failed-read', 10, true), end(1, 11)]
  const [captured] = captureForegroundTurns(events)
  assert.deepEqual(captured!.readMessageIds, ['human-a', 'human-b'])
  assert.deepEqual(captured!.claimedMessageIds, [])
  assert.deepEqual(captured!.claims, [])
})

test('replacement surface messages cannot relabel the original completed final time or model', () => {
  const original = final(1, 'stable-native-id', 'original visible answer', 1)
  const replacement = { ...final(1, 'stable-native-id', 'compacted presentation', 3, {
    source: { kind: 'model', provider: 'replacement-route', model: 'replacement-model' },
  }), surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } } as SessionEvent
  const [capture] = captureForegroundTurns([original, end(1, 2), replacement])
  assert.equal(capture!.final!.text, 'original visible answer')
  assert.equal(capture!.final!.time, original.time)
  assert.equal(capture!.final!.provider, 'actual-route')
  assert.equal(capture!.final!.model, 'actual-model')
})

test('a replacement tool result after completion is not evidence that a failed call succeeded', () => {
  const replacement = { ...result(1, 'failed-claim', 4), surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] } as SessionEvent
  const [capture] = captureForegroundTurns([call(1, 'failed-claim', 'dss_conversation_claim', { messageIds: ['human'] }, 1),
    result(1, 'failed-claim', 2, true), end(1, 3), replacement])
  assert.deepEqual(capture!.claimedMessageIds, [])
  assert.deepEqual(capture!.claims, [])
})
