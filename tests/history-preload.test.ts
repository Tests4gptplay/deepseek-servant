import test from 'node:test'
import assert from 'node:assert/strict'
import { createServantSource, type ServantClientApi } from '../src/client/source.js'
import type { ConversationQuery } from '../src/contracts/assistant.js'
import type { ServantView } from '../src/contracts/views.js'
import { daysIn, isoOf, shiftMonth, viewOf } from '../src/client/calendar.js'

const page = (ids: string[], before?: string) => ({
  assistant: { id: 'default' }, tasks: [], messages: ids.map(id => ({ id, ref: id, role: 'assistant', text: id })),
  ...(before ? { conversationBefore: before } : {}),
}) as ServantView
const ids = (source: ReturnType<typeof createServantSource>) => source.source.getSnapshot().value?.messages.map(message => message.id)

test('older pages prepend without replacing visible messages; refresh and newer navigation retain the loaded window', async () => {
  const calls: ConversationQuery[] = []
  let statsReads = 0
  const source = createServantSource({
    view: async ({ conversation = {} } = {}) => {
      calls.push(conversation)
      return conversation.before === 'm3' ? page(['m1', 'm2']) : conversation.before === 'm5' ? page(['m3', 'm4'], 'm3') : page(['m5', 'm6'], 'm5')
    },
    retention: async () => { statsReads++; return { totalBytes: 0 } },
  } as ServantClientApi, () => {})
  await source.refresh()
  await source.historyPage('older')
  assert.deepEqual(ids(source), ['m3', 'm4', 'm5', 'm6'])
  assert.equal(statsReads, 1, 'paging does not rescan the storage domain')
  await source.refresh()
  assert.deepEqual(ids(source), ['m3', 'm4', 'm5', 'm6'])
  await source.historyPage('older')
  assert.deepEqual(ids(source), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'])
  assert.equal(source.source.getSnapshot().value?.conversationBefore, undefined)
  const count = calls.length
  await source.historyPage('older')
  assert.equal(calls.length, count)
  await source.historyPage('newer')
  assert.deepEqual(ids(source), ['m3', 'm4', 'm5', 'm6'])
  await source.historyPage('latest')
  assert.deepEqual(ids(source), ['m5', 'm6'])
})

test('one preload stays in flight; a date jump supersedes its late response', async () => {
  let release!: (view: ServantView) => void
  let olderCalls = 0
  const source = createServantSource({
    view: async ({ conversation = {} } = {}) => {
      if (conversation.date) return page(['day-only'])
      if (conversation.before) { olderCalls++; return new Promise<ServantView>(resolve => { release = resolve }) }
      return page(['latest'], 'cursor')
    },
    retention: async () => ({ totalBytes: 0 }),
  } as ServantClientApi, () => {})
  await source.refresh()
  const pending = source.historyPage('older')
  await source.historyPage('older')
  assert.equal(olderCalls, 1)
  await source.historyPage('date', '2026-10-25')
  release(page(['late-older']))
  await pending
  assert.deepEqual(ids(source), ['day-only'])
  assert.equal(source.source.getSnapshot().history.date, '2026-10-25')
  await source.historyPage('date', '')
  assert.deepEqual(ids(source), ['latest'])
})

test('a failed preload retains the reading window and retries the same cursor once requested again', async () => {
  let fail = true
  const cursors: string[] = []
  const source = createServantSource({
    view: async ({ conversation = {} } = {}) => {
      if (!conversation.before) return page(['latest'], 'cursor')
      cursors.push(conversation.before)
      if (fail) { fail = false; throw new Error('Disconnected') }
      return page(['older'])
    },
    retention: async () => ({ totalBytes: 0 }),
  } as ServantClientApi, () => {})
  await source.refresh()
  await source.historyPage('older')
  assert.deepEqual(ids(source), ['latest'])
  assert.equal(source.source.getSnapshot().history.canGoNewer, false)
  await source.historyPage('older')
  assert.deepEqual(cursors, ['cursor', 'cursor'])
  assert.deepEqual(ids(source), ['older', 'latest'])
})

test('calendar uses ISO local dates and clamps month changes through leap years and year boundaries', () => {
  assert.deepEqual(viewOf('2026-10-26'), { year: 2026, month: 9, day: 26 })
  assert.equal(daysIn({ year: 2024, month: 1 }), 29)
  assert.equal(daysIn({ year: 2026, month: 1 }), 28)
  assert.deepEqual(shiftMonth({ year: 2024, month: 0, day: 31 }, 1), { year: 2024, month: 1, day: 29 })
  assert.deepEqual(shiftMonth({ year: 2026, month: 0, day: 31 }, -1), { year: 2025, month: 11, day: 31 })
  assert.equal(isoOf({ year: 2026, month: 0 }, 2), '2026-01-02')
})
