import test from 'node:test'
import assert from 'node:assert/strict'
import { createFrameworkClientNotices, type FrameworkNoticeScope } from '../src/framework/client-notices.js'
import { frameworkScopeKey, type FrameworkClientTask, type FrameworkClientView } from '../src/framework/client-contracts.js'
const scope: FrameworkNoticeScope = { mode: 'local', collaborationId: 'shared', storageScope: 'root-one' }
const task = (taskId: string, status: 'running' | 'complete', title = taskId): FrameworkClientTask => ({ taskId, status, title, route: 'O', owner: 'A' })
const view = (tasks: FrameworkClientTask[], selected = scope): Pick<FrameworkClientView, 'activeMode' | 'collaborationId' | 'storageScope' | 'tasks'> => ({ activeMode: selected.mode, collaborationId: selected.collaborationId, storageScope: selected.storageScope, tasks })
const key = (selected = scope) => frameworkScopeKey(selected.mode, selected.collaborationId, selected.storageScope)

test('first historical complete baseline is silent; running-to-complete produces one actual task notice', () => {
  const notices = createFrameworkClientNotices(), initial = notices.getSnapshot()
  notices.observe(view([task('old', 'complete'), task('work', 'running')]))
  assert.equal(notices.getSnapshot(), initial)
  notices.observe(view([task('old', 'complete'), task('work', 'complete', 'Validated task title')]))
  assert.deepEqual(notices.getSnapshot().notice, { id: JSON.stringify([key(), 'work']), scopeKey: key(), taskId: 'work', title: 'Validated task title', kind: 'success', key: 'completed' })
  assert.equal(notices.getSnapshot().unread[key()], 1)
  const after = notices.getSnapshot()
  notices.observe(view([task('old', 'complete'), task('work', 'complete')]))
  assert.equal(notices.getSnapshot(), after, 'duplicate snapshots are a no-op')
})

test('new complete tasks after baseline are queued without inventing Foreground prose or waiting for Recorder', () => {
  const notices = createFrameworkClientNotices()
  notices.observe(view([]))
  notices.observe(view([task('one', 'complete'), task('two', 'complete')]))
  assert.equal(notices.getSnapshot().notice!.taskId, 'one')
  assert.equal(notices.getSnapshot().unread[key()], 2)
  assert.equal('text' in notices.getSnapshot().notice!, false)
  notices.dismiss()
  assert.equal(notices.getSnapshot().notice!.taskId, 'two')
  assert.equal(notices.getSnapshot().unread[key()], 2, 'toast dismissal is not local badge acknowledgement')
  notices.dismiss()
  assert.equal(notices.getSnapshot().notice, undefined)
})

test('mode, collaboration and storage root each isolate baselines and local acknowledgements', () => {
  const notices = createFrameworkClientNotices()
  const scopes: FrameworkNoticeScope[] = [scope, { ...scope, mode: 'git' }, { ...scope, collaborationId: 'other' }, { ...scope, storageScope: 'root-two' }]
  for (const selected of scopes) {
    notices.observe(view([task('history', 'complete'), task('same-id', 'running')], selected))
    notices.observe(view([task('history', 'complete'), task('same-id', 'complete')], selected))
  }
  assert.equal(Object.keys(notices.getSnapshot().unread).length, 4)
  const notice = notices.getSnapshot().notice
  notices.ackLocal(scopes[1]!)
  assert.equal(notices.getSnapshot().unread[key(scopes[1])], undefined)
  assert.equal(notices.getSnapshot().unread[key(scope)], 1)
  assert.equal(notices.getSnapshot().notice, notice, 'opening a panel only clears its local badge')
  notices.observe(view([task('history', 'complete'), task('same-id', 'complete')], scopes[1]))
  assert.equal(notices.getSnapshot().unread[key(scopes[1])], undefined, 'repeated complete does not recreate a cleared badge')
})

test('disappearing/returning task and stale running projections cannot redeliver completed task identity', () => {
  const notices = createFrameworkClientNotices()
  notices.observe(view([task('work', 'running')]))
  notices.observe(view([task('work', 'complete')]))
  notices.dismiss(); notices.ackLocal(scope)
  notices.observe(view([]))
  notices.observe(view([task('work', 'running')]))
  notices.observe(view([task('work', 'complete')]))
  assert.equal(notices.getSnapshot().notice, undefined)
  assert.deepEqual(notices.getSnapshot().unread, {})
})

test('store subscriptions and stable immutable snapshots require no API writes, timers or page lifetime', () => {
  const notices = createFrameworkClientNotices()
  let updates = 0
  const off = notices.subscribe(() => { updates++ })
  const input = view([task('task', 'running')]), before = structuredClone(input)
  notices.observe(input)
  notices.observe(view([task('task', 'complete')]))
  assert.deepEqual(input, before)
  assert.equal(updates, 1)
  assert.equal(Object.isFrozen(notices.getSnapshot()), true)
  assert.equal(Object.isFrozen(notices.getSnapshot().unread), true)
  notices.ackLocal({ ...scope, collaborationId: 'absent' })
  assert.equal(updates, 1)
  off()
  notices.dismiss(); notices.ackLocal(scope)
  assert.equal(updates, 1)
})
