import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { conversationMessages, conversationSnapshot } from '../src/adapters/dsh/conversation.js'

const user = { id: 'human', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }
const event = (type: string, data: unknown, seq: number) => ({ type, data, seq, time: 1_800_000_000_000 + seq,
  ...(['user/message', 'assistant/message'].includes(type) ? { surfaceOp: 'append' } : {}) }) as SessionEvent
const result = (id: string, content: unknown[], replayState?: unknown) => ({ turn: 1, step: 1, stream: [],
  message: { id, role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test', replayState }, content } })
const end = () => event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 9)

test('non-completed terminal turns retain consumed identities without adding a completed exchange', () => {
  const snapshot = conversationSnapshot([event('turn/start', { turn: 1 }, 0), event('user/message', user, 1),
    event('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'Disconnected' } } }, 2)])
  assert.equal(snapshot.finished, false)
  assert.deepEqual(snapshot.turns, [])
  assert.deepEqual(snapshot.ended?.messageIds, ['human'])
  assert.equal(snapshot.ended?.message, 'Disconnected')
})

test('Codex shows only the model final answer, excluding injected diagnostics and commentary', () => {
  const text = '你好，我在。\nCodex: 这一行是回答本身，保留原文。'
  const assistant = event('assistant/message', result('answer', [
    { type: 'text', text: 'Codex: Under-development features enabled: skip_host_skill_discovery.\n\n' },
    { type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: '我先查看设置。' }, { type: 'text', text },
  ], { response: { kind: 'codex-app-server', version: 4, contextItems: [], items: [
    { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '我先查看设置。' }] },
    { type: 'reasoning', content: [{ type: 'text', text: 'private reasoning' }] },
    { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] },
  ] } }), 5)
  const events = [event('user/message', user, 1), assistant]
  assert.deepEqual(conversationMessages(events).map(message => message.text), ['你好'])
  assert.deepEqual(conversationMessages([...events, end()]).map(message => message.text), ['你好', text])
  assert.match(JSON.stringify(assistant), /Under-development/)
})
test('normal providers show the final text without tool-step commentary or reasoning', () => {
  const events = [event('user/message', user, 1),
    event('assistant/message', result('working', [{ type: 'text', text: 'Checking...' }, { type: 'tool-call', id: 'call', name: 'read', arguments: '{}' }]), 2),
    event('assistant/message', result('answer', [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: '已完成。' }]), 4), end()]
  assert.deepEqual(conversationMessages(events).map(message => message.text), ['你好', '已完成。'])
})
test('queued users appear once; plugin instructions and diagnostic-only responses stay out of chat', () => {
  const events = [event('agent/inbox/spliced', { inserted: [user] }, 1), event('user/message', user, 2),
    event('user/message', { ...user, id: 'plugin', source: { kind: 'skill' }, content: [{ type: 'text', text: 'Plugin loaded' }] }, 3),
    event('assistant/message', result('notice', [{ type: 'text', text: 'Codex: startup notice\n\n' }],
      { response: { kind: 'codex-app-server', version: 4, contextItems: [], items: [] } }), 4), end()]
  assert.deepEqual(conversationMessages(events).map(message => message.text), ['你好'])
})
