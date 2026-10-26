import assert from 'node:assert/strict'
import test from 'node:test'
import { AssistantService, deliveryMessageText, type AssistantRuntimePort } from '../src/application/assistant-service.js'
import { ConversationStore } from '../src/application/conversation-store.js'
import type { Assistant, AssistantInputEvidence, ConversationMessage, ForegroundCapture } from '../src/contracts/assistant.js'
import type { Delivery } from '../src/contracts/task.js'
import { MemoryStorage } from './support.js'

const defaults = { name: 'Servant', presetId: 'default', foreground: { provider: 'test', model: 'foreground' }, background: {} }
const workspace = { id: 'workspace', directory: 'C:/isolated' }
const delivery: Delivery = { id: 'result-1', summary: 'Accepted result', artifacts: [], resultIds: ['one'], createdAt: '2026-10-25T15:00:00Z', status: 'pending' }
class NativeFixture implements AssistantRuntimePort {
  sessions = new Map<string, ForegroundCapture>()
  evidence = new Map<string, Map<string, AssistantInputEvidence>>()
  calls: Array<{ kind: string; sessionId: string; id?: string; text?: string; source?: string }> = []
  owner?: string
  jobs = false
  now = '2026-10-25T14:59:00.000Z'
  async send(assistant: Assistant, text: string, id: string, source: 'user' | 'deepseek-servant' = 'user') {
    assert.ok(!this.owner || this.owner === assistant.sessionId, 'old physical owner must retire before the next session starts')
    this.owner = assistant.sessionId
    const inputs = this.evidence.get(assistant.sessionId) ?? new Map<string, AssistantInputEvidence>()
    if (inputs.has(id)) return
    inputs.set(id, { state: 'consumed', text, source }); this.evidence.set(assistant.sessionId, inputs)
    this.calls.push({ kind: 'send', sessionId: assistant.sessionId, id, text, source })
    this.sessions.set(assistant.sessionId, { messages: [{ id, role: source === 'user' ? 'user' : 'system', source, text, at: this.now, turn: 1 }], turns: [], finished: false })
  }
  finish(sessionId: string, text: string) {
    const snapshot = this.sessions.get(sessionId)!
    const message: ConversationMessage = { id: 'answer-' + sessionId, role: 'assistant', text, source: 'model', at: this.now, turn: 1 }
    snapshot.messages.push(message)
    snapshot.turns = [{ turn: 1, at: this.now, messageIds: snapshot.messages.map(message => message.id) }]
    snapshot.finished = true
  }
  async hasInput(sessionId: string, id: string) { return this.evidence.get(sessionId)?.has(id) ?? false }
  async inputs(sessionId: string) { return this.evidence.get(sessionId) ?? new Map<string, AssistantInputEvidence>() }
  async capture(sessionId: string) { return structuredClone(this.sessions.get(sessionId) ?? { messages: [], turns: [], finished: false }) }
  async conversation(sessionId: string) { return (await this.capture(sessionId)).messages }
  async resume(assistant: Assistant, messageId: string) { this.calls.push({ kind: 'resume', sessionId: assistant.sessionId, id: messageId }) }
  async retire(assistant: Assistant) {
    this.calls.push({ kind: 'retire-check', sessionId: assistant.sessionId })
    if (this.jobs) return false
    if (this.owner) assert.equal(this.owner, assistant.sessionId)
    this.owner = undefined
    this.calls.push({ kind: 'retired', sessionId: assistant.sessionId })
    return true
  }
  async cancel(assistant: Assistant) {
    this.calls.push({ kind: 'cancel', sessionId: assistant.sessionId })
    if (this.jobs) return false
    this.owner = undefined
    return true
  }
  async prepareConfiguration() { assert.equal(this.owner, undefined) }
  async deliver(assistant: Assistant, value: Delivery, id: string) { await this.send(assistant, deliveryMessageText(value), id, 'deepseek-servant') }
}
function fixture(store = new MemoryStorage(), native = new NativeFixture()) {
  const options = { store, runtime: native, defaults, resolveWorkspace: async () => workspace, timeZone: 'Asia/Tokyo', now: () => native.now }
  return { store, native, options, service: new AssistantService(options) }
}

test('a failed consumed turn retires after its jobs settle and does not replay before the next input', async () => {
  const { service, native } = fixture()
  await service.sendMessage('default', 'failed-input', 'Do the original request')
  const current = await service.get(), snapshot = native.sessions.get(current.sessionId)!
  snapshot.ended = { reason: 'error', message: 'Provider disconnected', messageIds: ['failed-input'], at: native.now }
  native.jobs = true
  await service.sendMessage('default', 'next-input', 'Continue with this new instruction')
  assert.equal(native.calls.filter(call => call.kind === 'send').length, 1)
  native.jobs = false
  await service.advance('default')
  assert.equal(native.calls.filter(call => call.kind === 'send' && call.id === 'failed-input').length, 1)
  assert.equal(native.calls.filter(call => call.kind === 'send' && call.id === 'next-input').length, 1)
  assert.equal((await service.conversations.seed('default')).length, 0)
  assert.ok((await service.conversation()).some(message => message.text.includes('Provider disconnected')))
  assert.equal((await service.userInput('default', 'failed-input'))?.text, 'Do the original request')
})

test('cold foreground recovery resumes consumed interrupted input without retiring or replaying the original', async () => {
  const { service, native, options } = fixture()
  await service.sendMessage('default', 'original', 'Continue this work')
  const current = await service.get()
  native.sessions.get(current.sessionId)!.ended = {
    reason: 'aborted', interrupted: true, messageIds: ['original'], at: native.now,
  }
  const restarted = new AssistantService(options)
  assert.deepEqual((await restarted.recoverInputs()).failed, [])
  assert.equal((await restarted.get()).sessionId, current.sessionId)
  assert.equal((await restarted.get()).activeMessageId, 'original')
  assert.equal(native.calls.filter(call => call.kind === 'send').length, 1)
  assert.deepEqual(native.calls.filter(call => call.kind === 'resume').map(call => call.id), ['original'])
  assert.equal(native.calls.filter(call => call.kind === 'retired').length, 0)
  native.finish(current.sessionId, 'Recovered answer')
  await restarted.advance('default')
  assert.equal((await restarted.get()).activeMessageId, undefined)
})

test('an inactive unconsumed foreground claim is readmitted on its original identity after power loss', async () => {
  const { service, native, options } = fixture()
  await service.sendMessage('default', 'original', 'Saved original')
  const current = await service.get()
  native.evidence.get(current.sessionId)!.set('original', { state: 'claimed', active: false, text: 'Saved original', source: 'user' })
  const send = native.send.bind(native)
  native.send = async (...args) => { native.evidence.get(args[0].sessionId)!.delete(args[2]); await send(...args) }
  assert.deepEqual((await new AssistantService(options).recoverInputs()).failed, [])
  assert.deepEqual(native.calls.filter(call => call.kind === 'send').map(call => [call.sessionId, call.id]),
    [[current.sessionId, 'original'], [current.sessionId, 'original']])
})

test('model settings can repair an admission that never entered the native inbox', async () => {
  const { service, native } = fixture(), send = native.send.bind(native)
  let fail = true
  native.send = async (...args) => { if (fail) throw new Error('Provider is not configured'); await send(...args) }
  await assert.rejects(service.sendMessage('default', 'unadmitted', 'Keep this original input'), /not configured/)
  const current = await service.get()
  fail = false
  await service.configure('default', { expectedRevision: current.revision,
    settings: { ...current.settings, foreground: { provider: 'fixed', model: 'working' } } })
  assert.equal(native.calls.filter(call => call.kind === 'send' && call.id === 'unadmitted').length, 1)
  assert.equal((await service.get()).activeMessageId, 'unadmitted')
})

test('T13/T14: every complete interaction retires its owner, keeps exact originals and seeds the last six exchanges', async () => {
  const { service, store, native } = fixture()
  const sessions: string[] = []
  for (let i = 0; i < 9; i++) {
    native.now = new Date(Date.UTC(2026, 9, 25, 14, 50 + i)).toISOString()
    await service.sendMessage('default', 'user-' + i, 'Original question ' + i + '\n  preserve spaces  ')
    const current = await service.get()
    sessions.push(current.sessionId)
    native.finish(current.sessionId, 'Complete answer ' + i + '\nsecond line')
    await service.advance('default', current.sessionId)
  }
  assert.equal(new Set(sessions).size, 9)
  const seed = await service.conversations.seed('default')
  assert.deepEqual(seed.map(exchange => exchange.map(message => message.text)), Array.from({ length: 6 }, (_, i) => [
    'Original question ' + (i + 3) + '\n  preserve spaces  ', 'Complete answer ' + (i + 3) + '\nsecond line']))
  const root = (await store.get<Assistant>('assistant/default'))!
  assert.deepEqual(root.inputs, {}); assert.deepEqual(root.deliveries, {}); assert.deepEqual(root.priorSessionIds, [])
  assert.equal(Object.keys(root.sessionWorkspaces).length, 1)
  assert.equal(root.latestUser?.text, undefined)
  assert.ok(JSON.stringify(root).length < 1800)
  assert.equal((await service.userInput('default', 'user-0'))?.text, 'Original question 0\n  preserve spaces  ')
  assert.equal((await service.sendMessage('default', 'user-0', 'Original question 0\n  preserve spaces  ')).status, 'duplicate')
  await assert.rejects(service.sendMessage('default', 'user-0', 'different original'), /同一消息标识/)
  assert.equal(native.calls.filter(call => call.kind === 'send').length, 9)
  assert.equal(native.calls.filter(call => call.kind === 'retired').length, 9)
})

test('T14: busy user and system delivery survive restart; native jobs delay retirement without duplicate admissions', async () => {
  const { service, native, options } = fixture()
  await service.sendMessage('default', 'first', 'First user')
  const first = await service.get()
  await service.sendMessage('default', 'second', 'Queued user')
  const notificationId = await service.deliver('default', 'task', delivery)
  assert.equal(native.calls.filter(call => call.kind === 'send').length, 1)
  const restarted = new AssistantService(options)
  assert.deepEqual((await restarted.recoverInputs()).failed, [])
  assert.equal(native.calls.filter(call => call.kind === 'send').length, 1)
  native.finish(first.sessionId, 'First answer'); native.jobs = true
  await restarted.advance('default')
  assert.equal((await restarted.get()).sessionId, first.sessionId)
  assert.equal(native.calls.filter(call => call.kind === 'send').length, 1)
  native.jobs = false; await restarted.advance('default')
  const second = await restarted.get()
  assert.equal(second.activeMessageId, 'second')
  native.finish(second.sessionId, 'Second answer'); await restarted.advance('default')
  const notification = await restarted.get()
  assert.equal(notification.activeMessageId, notificationId)
  assert.equal(native.calls.filter(call => call.kind === 'send').at(-1)?.source, 'deepseek-servant')
  native.finish(notification.sessionId, 'Delivered outcome'); await restarted.advance('default')
  assert.equal((await restarted.conversations.seed('default')).length, 2)
  assert.deepEqual((await restarted.conversation()).map(message => message.text), [
    'First user', 'Queued user', 'First answer', 'Second answer', 'Delivered outcome'])
  assert.equal(await restarted.userInput('default', notificationId), undefined)
  assert.equal(await restarted.deliver('default', 'task', delivery), notificationId)
  assert.equal(native.calls.filter(call => call.kind === 'send').length, 3)
})

test('T14: an archive failure prevents retirement; a lost post-retirement root write replays without losing or resending input', async () => {
  const { service, store, native, options } = fixture()
  await service.sendMessage('default', 'first', 'Preserve me')
  const first = await service.get()
  native.finish(first.sessionId, 'Archived answer')
  store.fail = key => key.startsWith('conversation-index/') && !store.data.has(key)
  await assert.rejects(service.advance('default'), /Injected storage interruption/)
  assert.equal(native.calls.filter(call => call.kind === 'retired').length, 0)
  store.fail = (key, value) => key === 'assistant/default' && !(value as Assistant).activeMessageId
  await assert.rejects(service.advance('default'), /Injected storage interruption/)
  assert.equal(native.calls.filter(call => call.kind === 'retired').length, 1)
  store.fail = undefined
  const restarted = new AssistantService(options)
  assert.deepEqual((await restarted.recoverInputs()).failed, [])
  assert.deepEqual((await restarted.get()).inputs, {})
  assert.equal(native.calls.filter(call => call.kind === 'send').length, 1)
  assert.deepEqual((await restarted.conversation()).map(message => message.text), ['Preserve me', 'Archived answer'])
  assert.equal((await restarted.conversations.seed('default')).length, 1)
})

test('T13: long originals, midnight dates, reference paging and failed-index retry keep exact content and stable identity', async () => {
  const storage = new MemoryStorage()
  let now = '2026-10-25T14:59:59.999Z'
  let conversations = new ConversationStore(storage, 'Asia/Tokyo', () => now)
  const text = '完整原文😀\n'.repeat(100000)
  storage.fail = key => key.startsWith('conversation-index/')
  await assert.rejects(conversations.append('assistant', 'session', { id: 'long', role: 'user', text }), /Injected/)
  now = '2026-10-25T15:00:00.001Z'; storage.fail = undefined
  conversations = new ConversationStore(storage, 'Asia/Tokyo', () => now)
  const original = await conversations.append('assistant', 'session', { id: 'long', role: 'user', text })
  assert.equal(original.date, '2026-10-25')
  assert.equal(original.at, '2026-10-25T14:59:59.999Z')
  const answer = await conversations.append('assistant', 'session', { id: 'answer', role: 'assistant', text: '跨午夜答复' })
  assert.equal(answer.date, '2026-10-26')
  let recovered = '', cursor: number | undefined = 0
  while (cursor !== undefined) { const page = await conversations.read('assistant', original.ref, cursor, 262144); recovered += page.text; cursor = page.nextCursor }
  assert.equal(recovered, text)
  assert.equal((await conversations.search('assistant', '午夜')).matches[0]?.message.ref, answer.ref)
  assert.equal((await conversations.page('assistant', undefined, 40, '2026-10-25')).messages[0]?.ref, original.ref)
  const newest = await conversations.page('assistant', undefined, 1)
  assert.equal(newest.messages[0]?.ref, answer.ref)
  assert.equal((await conversations.page('assistant', newest.before, 1)).messages[0]?.ref, original.ref)
  await assert.rejects(conversations.read('another-assistant', original.ref), /another assistant/)
  assert.equal((await storage.list('conversations/assistant/2026-10-25/entry/')).length, 1)
  assert.equal((await storage.list('conversation-staging/')).length, 0)
})

test('T13: legacy session backfill is idempotent and moves originals and receipts out of the hot root', async () => {
  const { service, store, native, options } = fixture()
  await service.sendMessage('default', 'legacy-user', 'Historical original')
  const original = await service.get()
  native.finish(original.sessionId, 'Historical answer')
  original.historyMigrated = false
  original.inputs['legacy-user']!.text = 'Historical original'
  original.latestUser!.text = 'Historical original'
  await store.set('assistant/default', original)
  const migrated = await new AssistantService(options).get()
  assert.equal(migrated.historyMigrated, true)
  assert.deepEqual(migrated.inputs, {})
  assert.equal(migrated.latestUser?.text, undefined)
  assert.deepEqual((await new AssistantService(options).conversation()).map(message => message.text), ['Historical original', 'Historical answer'])
  assert.equal((await store.list('conversation-index/')).length, 2)
})

test('Explicit conversation deletion stops only foreground and keeps pending completion delivery plus task originals', async () => {
  const { service, store, native } = fixture()
  await service.sendMessage('default', 'old-question', 'Original chat to clear')
  const old = await service.get()
  await store.set('task-origin/one/original', { request: 'Permanent task request' })
  await store.set('knowledge/facts/kept', { text: 'Useful knowledge' })
  await store.set('conversations/another-assistant/original', { text: 'Other assistant' })
  await service.deliver('default', 'one', delivery)
  await service.clearConversation()
  const fresh = await service.get()
  assert.notEqual(fresh.sessionId, old.sessionId)
  assert.equal(fresh.latestUser, undefined)
  assert.deepEqual((await service.conversation()).map(message => message.text), [])
  assert.deepEqual(await service.conversations.seed('default'), [])
  assert.ok(native.calls.some(call => call.kind === 'cancel' && call.sessionId === old.sessionId))
  const sent = native.calls.filter(call => call.kind === 'send')
  assert.equal(sent.length, 2)
  assert.equal(sent[1]?.source, 'deepseek-servant')
  assert.ok(sent[1]?.text?.includes('Accepted result'))
  assert.ok(await store.get('task-origin/one/original'))
  assert.ok(await store.get('knowledge/facts/kept'))
  assert.ok(await store.get('conversations/another-assistant/original'))
  native.finish(fresh.sessionId, 'The saved background result is ready.')
  await service.advance('default')
  assert.deepEqual((await service.conversation()).map(message => message.text), ['The saved background result is ready.'])
})

test('Interrupted conversation deletion resumes from the exact cleanup list without backfilling deleted native history', async () => {
  const { service, store, native, options } = fixture()
  await service.sendMessage('default', 'question', 'Chat before deletion')
  const old = await service.get()
  native.finish(old.sessionId, 'Old answer')
  await service.advance('default')
  const remove = store.delete.bind(store)
  let interrupted = false
  store.delete = async key => {
    if (!interrupted && key.startsWith('conversation-index/')) { interrupted = true; throw new Error('Interrupted cleanup') }
    await remove(key)
  }
  await assert.rejects(service.clearConversation(), /Interrupted cleanup/)
  const restarted = new AssistantService(options)
  assert.deepEqual(await restarted.conversation(), [])
  assert.deepEqual(await restarted.conversations.seed('default'), [])
  assert.equal((await store.list('conversation-cleanup/')).length, 0)
  await restarted.sendMessage('default', 'new-question', 'New original')
  assert.deepEqual((await restarted.conversation()).map(message => message.text), ['New original'])
})

