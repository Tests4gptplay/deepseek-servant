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
    return { ...entry, data: { ...entry.data, message: { ...entry.data.message, content: [{ type: 'text' as const, text: JSON.stringify(value) }] } } }
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

test('a successful original-text page identifies its actual human source without treating search snippets as a claim', () => {
  const textBase = result(1, 'text', 2) as SessionEvent<'tool/result'>
  const text: SessionEvent<'tool/result'> = { ...textBase, data: { ...textBase.data, message: { ...textBase.data.message, content: [{ type: 'text', text: JSON.stringify({ ref: 'human-text', message: { id: 'human-text', role: 'user' }, text: 'Exact original page', cursor: 0, characters: 200, nextCursor: 19 }) }] } } }
  const searchBase = result(1, 'search', 4) as SessionEvent<'tool/result'>
  const search: SessionEvent<'tool/result'> = { ...searchBase, data: { ...searchBase.data, message: { ...searchBase.data.message, content: [{ type: 'text', text: JSON.stringify({ matches: [{ message: { ref: 'other', id: 'other', role: 'user' }, excerpt: 'matching snippet' }] }) }] } } }
  const [turn] = captureForegroundTurns([call(1, 'text', 'dss_conversation_read', { mode: 'text', reference: 'human-text' }, 1), text,
    call(1, 'search', 'dss_conversation_read', { mode: 'search', query: 'matching' }, 3), search, end(1, 5)])
  assert.deepEqual(turn.readMessageIds, ['human-text'])
  assert.deepEqual(turn.claimedMessageIds, [])
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFiles } from '../src/framework/local-files.js'
import { FrameworkRoleRuntime } from '../src/framework/role-runtime.js'
import { withSnapshot, FilesConflictError, FilesOutcomeUnknownError } from '../src/framework/transactions.js'
async function runtimeFixture(t: test.TestContext) {
  const directory=await mkdtemp(join(tmpdir(),'dss-role-composition-')),files=await LocalFiles.open(directory)
  t.after(async()=>{await files.close();await rm(directory,{recursive:true,force:true})})
  const rows=new Map<string,any>()
  const storage={get:async<T>(key:string)=>structuredClone(rows.get(key)) as T|undefined,set:async(key:string,value:unknown)=>{rows.set(key,structuredClone(value))},list:async<T>(prefix:string)=>[...rows].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value:structuredClone(value) as T}))}
  const ctx={agents:{get:()=>undefined},jobs:{list:()=>[]},get:()=>undefined} as any
  const errors: unknown[] = []
  const runtime=new FrameworkRoleRuntime(ctx,files,storage,{scope:'local',member:'A',primary:true,workspace:directory,workerSeats:2,mode:'local',collaborationId:'shared'},
    {members:()=>['A','B','empty','completed'],resources:()=>[],heartbeat:async()=>{},error:(error:unknown)=>errors.push(error)}) as any
  return {runtime,files,storage,rows,errors}
}
async function completedForegroundFixture(t: test.TestContext) {
  const fixture = await runtimeFixture(t), { runtime } = fixture
  await runtime.conversation.send('human', { id: 'human', role: 'user', participantId: 'human',
    createdAt: '2026-11-01T00:00:00.000Z', text: 'original question', recipient: 'ai' })
  const pending = await runtime.conversation.pendingForeground()
  await runtime.conversation.claimForeground('claimed', ['human'], { list: 'original', cache: 'preserved' }, { expectedRevision: pending.revision })
  const event = (type: string, data: unknown, seq: number) => ({ type, data, seq, time: 1793491200000 + seq,
    ...(['user/message', 'assistant/message', 'tool/result'].includes(type) ? { surfaceOp: 'append' } : {}) })
  const events = [event('turn/start', { turn: 1 }, 0),
    event('user/message', { id: 'original-native-input', role: 'user', source: { kind: 'deepseek-servant' }, content: [{type:'text', text:'original responsibility'}] }, 1),
    event('tool/call', {turn:1, step:0, callId:'claim', name:'dss_conversation_claim', arguments:JSON.stringify({messageIds:['human']})}, 2),
    event('tool/result', {turn:1, step:0, message:{id:'claim-result',role:'tool',source:{kind:'tool',callId:'claim'},toolCallId:'claim',content:[{type:'text',text:'{}'}]}}, 3),
    event('assistant/message', {turn:1,step:1,stream:[],message:{id:'actual-native-final',role:'assistant',source:{kind:'model',provider:'actual',model:'actual-model'},content:[{type:'text',text:'  actual answer\n原文'}]}}, 4),
    event('turn/end', {turn:1,reason:{kind:'completed'}}, 5)]
  const sessionId = 'completed-session'
  const persistence = { stat: async()=>({sizeBytes:123}), open:async()=>({header:{id:sessionId,createdAt:0,version:4}, inheritedEventCount:0,
    read:async()=>({events}),close:async()=>{}}) }
  runtime.ctx = {agents:{get:()=>undefined},sessions:{get:()=>undefined},jobs:{list:()=>[]},get:(name:string)=>name==='sessionPersistence'?persistence:name==='sessionProjections'?{
    restore:()=>({checkpoint:{inbox:{val:{'next-turn':[],'next-step':[]}},turnBoundary:{val:{lastTurn:1,openTurnStartSeq:null}}}})}:undefined}
  const request = {id:'completed-wake',role:'Foreground',reason:'notification',sources:[]}
  const record = {identity:{workId:runtime.roleKey('Foreground'),executionId:'completed-execution',role:'Foreground'},sessionId,generation:1,
    lastWake:request,delivery:{request,messageId:'original-native-input',text:'original responsibility',confirmed:true}}
  await runtime.saveRole(record)
  return { ...fixture, record }
}


test('capture retries successive proven new-HEAD conflicts in one owned round without losing concurrent Task and chat writes', async t => {
  const { runtime, files, record } = await completedForegroundFixture(t)
  const commit = files.commit.bind(files), send = runtime.conversation.send.bind(runtime.conversation)
  let competing = false, conflicts = 0, stops = 0
  const commands: string[] = []
  runtime.stopOwnedRecord = async () => { stops++; return { status: 'stopped' } }
  runtime.conversation.send = async (command: string, message: any, options: any) => {
    if (command.startsWith('native-capture/')) commands.push(command)
    return send(command, message, options)
  }
  files.commit = async (snapshot, changes, message) => {
    if (!competing && conflicts < 2 && changes.some(change => change.path === runtime.conversation.indexPath)) {
      competing = true
      if (conflicts++ === 0) await withSnapshot(files, latest => commit(latest, [{ path: 'task-runs/other-task/notes.md', content: 'Other Task exact progress' }], 'independent Task progress'))
      else await send('new-human', { id: 'next-human', role: 'user', participantId: 'human', createdAt: '2026-11-01T00:00:01.000Z', text: 'New original question 中文', recipient: 'ai' })
      competing = false
    }
    return commit(snapshot, changes, message)
  }
  await runtime.finishForegroundRound(record)
  await Promise.all([...runtime.stopOperations.values()].map((stop: any) => stop.promise))
  assert.equal(conflicts, 2); assert.equal(commands.length, 3); assert.equal(new Set(commands).size, 1)
  const page = await runtime.conversation.page(20), replies = page.messages.filter((message: any) => message.role === 'assistant')
  assert.equal(replies.length, 1); assert.equal(replies[0].text, '  actual answer\n原文'); assert.equal(replies[0].replyTo, 'human')
  assert.equal(page.messages.find((message: any) => message.id === 'next-human').text, 'New original question 中文')
  assert.ok((await runtime.conversation.pendingForeground()).messages.some((message: any) => message.id === 'next-human'))
  await withSnapshot(files, async snapshot => assert.equal(await files.read(snapshot, 'task-runs/other-task/notes.md'), 'Other Task exact progress'))
  assert.equal(stops, 1); assert.equal(runtime.roleRecords.get(record.identity.workId).completedRound, true)
})

for (const failure of ['unknown', 'permission', 'same-head'] as const) test('capture does not retry ' + failure + ' as a safe new-HEAD append conflict', async t => {
  const { runtime, files, record } = await completedForegroundFixture(t)
  const snapshot = await files.snapshot(), revision = snapshot.revision; await snapshot.release()
  const error = failure === 'unknown' ? new FilesOutcomeUnknownError('original-op') : failure === 'same-head' ? new FilesConflictError(revision) : new Error('403 permission denied')
  let calls = 0, stops = 0
  runtime.conversation.send = async () => { calls++; throw error }
  runtime.stopOwnedRecord = async () => { stops++; return { status: 'stopped' } }
  await assert.rejects(runtime.finishForegroundRound(record), (value: unknown) => value === error)
  assert.equal(calls, 1); assert.equal(stops, 0)
  assert.equal(runtime.roleRecords.get(record.identity.workId).completedRound, undefined)
  assert.equal((await runtime.conversation.page(20)).messages.filter((message: any) => message.role === 'assistant').length, 0)
})

for (const interruption of ['closed', 'replaced'] as const) test('capture cannot append its stale answer after ' + interruption + ' during proven conflict', async t => {
  const { runtime, files, record } = await completedForegroundFixture(t)
  let calls = 0, stops = 0
  runtime.stopOwnedRecord = async () => { stops++; return { status: 'stopped' } }
  runtime.conversation.send = async () => {
    calls++
    const old = await files.snapshot(); const revision = old.revision; await old.release()
    await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: 'task-runs/other-task/progress.md', content: 'Preserve independent progress' }], 'competing real commit'))
    if (interruption === 'closed') runtime.closed = true
    else runtime.roleRecords.set(record.identity.workId, { ...record, identity: { ...record.identity, executionId: 'replacement-execution' } })
    throw new FilesConflictError(revision)
  }
  await assert.rejects(runtime.finishForegroundRound(record))
  assert.equal(calls, 1); assert.equal(stops, 0)
  assert.equal(runtime.roleRecords.get(record.identity.workId).completedRound, undefined)
  assert.equal((await runtime.conversation.page(20)).messages.filter((message: any) => message.role === 'assistant').length, 0)
})
