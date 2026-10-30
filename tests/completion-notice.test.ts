import test from 'node:test'
import assert from 'node:assert/strict'
import { createServantSource, type ServantClientApi, type ServantNotice } from '../src/client/source.js'
import type { ServantView } from '../src/contracts/views.js'
import type { TaskView } from '../src/contracts/views.js'

test('New durable deliveries raise the native success notice once; existing unread tasks are acknowledged by task identity', async () => {
  const done = (id: string) => ({ id, goal: { objective: id }, delivery: { id: 'delivery', status: 'delivered' } }) as TaskView
  let view = { assistant: { id: 'default' }, tasks: [done('old')], messages: [] } as unknown as ServantView
  const notices: Array<Omit<ServantNotice, 'sequence'>> = [], acknowledged: string[] = []
  const source = createServantSource({
    view: async () => structuredClone(view),
    retention: async () => ({ totalBytes: 0 }),
    readDelivery: async ({ taskId }: { taskId: string }) => {
      acknowledged.push(taskId); view.tasks.find(task => task.id === taskId)!.delivery!.readAt = '2026-10-26T00:00:00Z'
    },
  } as ServantClientApi, notice => notices.push(notice))
  await source.refresh()
  assert.deepEqual(notices, [])
  view.tasks.push(done('new'))
  await source.refresh()
  assert.deepEqual(notices, [{ kind: 'success', key: 'completed', detail: 'new' }])
  await source.refresh()
  assert.equal(notices.length, 1)
  await source.readDeliveries(['old', 'new'])
  assert.deepEqual(acknowledged, ['old', 'new'])
  // Mutation receipts settle independently of the follow-up read.
  await source.refresh()
  assert.ok(source.source.getSnapshot().value?.tasks.every(task => task.delivery?.readAt))
})
