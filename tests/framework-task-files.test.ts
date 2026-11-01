import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFiles } from '../src/framework/local-files.js'
import { withSnapshot } from '../src/framework/transactions.js'
import { initializeTask, paths, readJson, discoverInbox, deliverMember, completeMember, claimSignals, type MemberStatus } from '../src/framework/task-files.js'
async function fixture(t: test.TestContext, route: 'P' | 'O') {
  const root = await mkdtemp(join(tmpdir(), 'dss-task-files-')), store = await LocalFiles.open(root)
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  const source = `tasks/test_${route}.md`
  await withSnapshot(store, snapshot => store.commit(snapshot, [{ path: source, content: '# Requirement\nExact original 😀\n' }], 'submit'))
  const task = await withSnapshot(store, async snapshot => {
    const plan = await initializeTask(store, snapshot, source, 'A', ['A1', 'B'])
    await store.commit(snapshot, plan.changes, 'initialize')
    return plan.value
  })
  return { store, task, source }
}
for (const route of ['P', 'O'] as const) test(`${route} initializes identity and records while preserving the original body`, async t => {
  const { store, task, source } = await fixture(t, route)
  await withSnapshot(store, async snapshot => {
    assert.equal(await store.read(snapshot, source), `Task ID: ${task.taskId}\n# Requirement\nExact original 😀\n`)
    assert.equal(task.route, route)
    assert.deepEqual((await initializeTask(store, snapshot, source, 'A', ['B'])).changes, [])
    assert.equal(await store.read(snapshot, paths.state('A', task.taskId) + '/Planner_Inbox'), undefined)
    assert.equal(await store.read(snapshot, paths.state('A', task.taskId) + '/Organizer_Task'), route === 'O' ? '' : undefined)
    assert.equal(await store.read(snapshot, paths.inbox(task.taskId, 'A')), route === 'P' ? '# Requirement\nExact original 😀\n' : '')
    const links = await readJson<{ links: Array<{ path: string }> }>(store, snapshot, paths.cache(task.taskId))
    assert.ok(links?.links.some(link => link.path === source))
    assert.ok((await store.list(snapshot, 'Recorder Cache/')).every(entry => entry.path.endsWith('links.json')))
  })
})
test('Inbox discovery creates the Planner notification once and completion does not redeliver', async t => {
  const { store, task } = await fixture(t, 'P')
  await withSnapshot(store, async snapshot => {
    const changes = await discoverInbox(store, snapshot, task.taskId, 'A')
    assert.equal(changes.length, 2)
    await store.commit(snapshot, changes, 'discover')
  })
  await withSnapshot(store, async snapshot => {
    assert.deepEqual(await discoverInbox(store, snapshot, task.taskId, 'A'), [])
    await store.commit(snapshot, await completeMember(store, snapshot, task.taskId, 'A', [{ path: paths.member(task.taskId, 'A') + '/Reply.md', content: 'result' }]), 'complete')
  })
  await withSnapshot(store, async snapshot => assert.deepEqual(await discoverInbox(store, snapshot, task.taskId, 'A'), []))
})
test('O completion claim leaves persistent member complete, rework same content becomes new delivery', async t => {
  const { store, task } = await fixture(t, 'O')
  await withSnapshot(store, async snapshot => store.commit(snapshot, await deliverMember(store, snapshot, task, 'B', 'work'), 'assign'))
  await withSnapshot(store, async snapshot => store.commit(snapshot, await discoverInbox(store, snapshot, task.taskId, 'B'), 'discover'))
  await withSnapshot(store, async snapshot => store.commit(snapshot, await completeMember(store, snapshot, task.taskId, 'B', []), 'complete'))
  await withSnapshot(store, async snapshot => store.commit(snapshot, await claimSignals(store, snapshot,
    [paths.state('B', task.taskId) + '/complete'], [{ path: paths.run(task.taskId) + '/Organizer_Note.md', content: 'Claim B result for review' }]), 'claim'))
  await withSnapshot(store, async snapshot => {
    assert.equal((await readJson<MemberStatus>(store, snapshot, paths.memberStatus(task.taskId, 'B')))?.state, 'complete')
    await store.commit(snapshot, await deliverMember(store, snapshot, task, 'B', 'work', [{ path: paths.run(task.taskId) + '/Organizer_Note.md', content: 'Review requires rework' }]), 'rework')
  })
  await withSnapshot(store, async snapshot => {
    assert.equal((await readJson<MemberStatus>(store, snapshot, paths.memberStatus(task.taskId, 'B')))?.state, 'running')
    assert.equal((await discoverInbox(store, snapshot, task.taskId, 'B')).length, 2)
  })
})
test('ordinary claims preserve recovery and unrelated Task state', async t => {
  const { store, task } = await fixture(t, 'P')
  const root = paths.state('A', task.taskId)
  await withSnapshot(store, snapshot => store.commit(snapshot, [
    { path: root + '/recovery', content: '' }, { path: root + '/Planner_Worker', content: '' },
    { path: 'state/A/other/Planner_Worker', content: '' },
  ], 'notify'))
  await withSnapshot(store, async snapshot => {
    await assert.rejects(claimSignals(store, snapshot, [root + '/recovery'], []), /recovery/)
    await store.commit(snapshot, await claimSignals(store, snapshot, [root + '/Planner_Worker'], [
      { path: paths.member(task.taskId, 'A') + '/Planner_Memory.md', content: 'Take over Worker result' },
    ]), 'claim')
  })
  await withSnapshot(store, async snapshot => {
    assert.equal(await store.read(snapshot, root + '/recovery'), '')
    assert.equal(await store.read(snapshot, 'state/A/other/Planner_Worker'), '')
    assert.equal(await store.read(snapshot, root + '/Planner_Worker'), undefined)
  })
})
