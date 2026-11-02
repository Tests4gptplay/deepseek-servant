import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFiles } from '../src/framework/local-files.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
import { FrameworkHostLoop, type HostLoopActions, type RoleWake } from '../src/framework/host-loop.js'
import { buildDirectSignal, workerWakeSignal } from '../src/framework/role-tools.js'
import { paths, readJson, encodeJson, type TaskMetadata } from '../src/framework/task-files.js'
import { withSnapshot } from '../src/framework/transactions.js'
import type { StoragePort } from '../src/contracts/ports.js'

async function fixture(run: (f: { files: LocalFiles; loop: FrameworkHostLoop; wakes: RoleWake[]; errors: unknown[]; busy(value: boolean): void; actions: string[]; hooks: HostLoopActions }) => Promise<void>, member = 'A') {
  const dir = await mkdtemp(join(tmpdir(), 'dss-host-loop-')), files = await LocalFiles.open(dir)
  const rows = new Map<string, unknown>(), wakes: RoleWake[] = [], errors: unknown[] = [], actions: string[] = []
  const records: StoragePort = { get: async key => structuredClone(rows.get(key)) as any, set: async (key,value) => { rows.set(key, structuredClone(value)) },
    list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key,value]) => ({ key, value: structuredClone(value) as any })) }
  let busy = false
  const hooks: HostLoopActions = { wake: async request => { wakes.push(request) }, executing: () => busy,
    sealBusiness: async () => { actions.push('seal') }, releaseTask: async () => { actions.push('release') }, clean: async () => { actions.push('clean') },
    startup: async () => { actions.push('startup') }, observe: async () => { actions.push('observe') }, error: error => errors.push(error) }
  const loop = new FrameworkHostLoop(files, new FrameworkTransactions(files, records, 'local'), records,
    { member, primary: true, scope: 'local' }, () => [member,'B'], hooks)
  try { await run({files, loop, wakes, errors, busy: value => { busy = value }, actions,hooks}) }
  finally { await loop.stop(); await files.close(); await rm(dir, {recursive:true,force:true}) }
}
async function put(files: LocalFiles, path: string, content: string) {
  await withSnapshot(files, snapshot => files.commit(snapshot, [{path,content}], 'test input'))
}
test('real Local task entry initializes, discovers Inbox then schedules Planner without consuming its signal', () => fixture(async f => {
  await put(f.files, 'tasks/work_P.md', 'preserved requirement')
  await f.loop.start()
  assert.equal(f.actions[0], 'startup')
  assert.equal(f.wakes.length, 0)
  await f.loop.poll() // Header version is now observed and Inbox delivery discovered.
  await f.loop.poll()
  const planner = f.wakes.find(wake => wake.role === 'Planner')!
  assert.ok(planner?.taskId)
  await withSnapshot(f.files, async snapshot => {
    assert.equal(await f.files.read(snapshot, paths.inbox(planner.taskId!, 'A')), 'preserved requirement')
    assert.equal(await f.files.read(snapshot, paths.state('A', planner.taskId!) + '/Planner_Inbox'), '')
    assert.equal((await readJson<TaskMetadata>(f.files, snapshot, paths.task(planner.taskId!)))?.route, 'P')
  })
  assert.deepEqual(f.errors, [])
}))
test('a running role keeps later signals pending rather than starting a second execution', () => fixture(async f => {
  await put(f.files, 'state/Planner_A_Direct_one', '')
  f.busy(true); await f.loop.poll(); assert.equal(f.wakes.length, 0)
  await withSnapshot(f.files, async snapshot => assert.equal(await f.files.read(snapshot, 'state/Planner_A_Direct_one'), ''))
  f.busy(false); await f.loop.poll()
  assert.equal(f.wakes[0]!.role, 'Planner'); assert.equal(f.wakes[0]!.taskId, undefined)
}))
test('direct work and shared Foreground signals work with no task tree; foreign direct targets stay untouched', () => fixture(async f => {
  await put(f.files, 'state/Worker_A_Direct_one', '')
  await put(f.files, 'state/Worker_B_Direct_other', '')
  await put(f.files, 'state/Foreground_ExampleUser-GMT9-20261031-040856123', '')
  await f.loop.poll()
  assert.deepEqual(f.wakes.map(wake => wake.role).sort(), ['Foreground','Worker'])
  assert.ok(f.wakes.every(wake => !wake.sources.some(source => source.path.includes('Worker_B'))))
}))
test('total completion seals business and independently arranges Foreground and Recorder only once', () => fixture(async f => {
  const id = '11111111-1111-4111-8111-111111111111'
  const metadata: TaskMetadata = { version:1, taskId:id, route:'O', sourcePath:'tasks/old_O.md', owner:'A', status:'complete' }
  await put(f.files, paths.task(id), encodeJson(metadata))
  await f.loop.poll(); await f.loop.poll()
  assert.deepEqual(f.wakes.map(wake => wake.role), ['Foreground','Recorder'])
  assert.equal(f.actions.filter(action => action === 'seal').length, 1)
  await put(f.files, paths.state('A', id) + '/Cleaner', '')
  await f.loop.poll()
  assert.equal(f.actions.at(-1), 'clean')
}))

test('ordinary Worker notification resolves its child from the basename', () => fixture(async f => {
  const id = '22222222-2222-4222-8222-222222222222'
  await put(f.files, paths.task(id), encodeJson({version:1,taskId:id,route:'P',sourcePath:'tasks/x_P.md',owner:'A',status:'running'}))
  await put(f.files, paths.state('A', id) + '/' + workerWakeSignal('child_one'), '')
  await f.loop.poll()
  assert.equal(f.wakes[0]?.role, 'Worker')
  assert.equal(f.wakes[0]?.workerId, 'child_one')
}))
test('direct notification decodes an underscored registered instance instead of raw prefix matching', () => fixture(async f => {
  await put(f.files, 'state/' + buildDirectSignal('Worker', 'A_1', 'direct_one'), '')
  await f.loop.poll()
  assert.equal(f.wakes[0]?.role, 'Worker')
  assert.equal(f.wakes[0]?.workerId, 'direct_one')
}, 'A_1'))

test('Organizer still receives completion from a task member absent from current discovered resources', () => fixture(async f => {
  const id = '33333333-3333-4333-8333-333333333333'
  await put(f.files, paths.task(id), encodeJson({version:1,taskId:id,route:'O',sourcePath:'tasks/x_O.md',owner:'A',status:'running',members:['A','offline-member']}))
  await put(f.files, paths.state('offline-member', id) + '/complete', '')
  await f.loop.poll()
  assert.equal(f.wakes[0]?.role, 'Organizer')
  assert.ok(f.wakes[0]?.sources[0]?.path.includes('offline-member'))
}))


test('failed business stop/seal cannot suppress either completed-task notification', () => fixture(async f => {
  const id = '44444444-4444-4444-8444-444444444444'
  await put(f.files, paths.task(id), encodeJson({version:1,taskId:id,route:'O',sourcePath:'tasks/x_O.md',owner:'A',status:'complete'}))
  f.hooks.sealBusiness = async () => { throw new Error('native producer stop unconfirmed') }
  await f.loop.poll()
  assert.deepEqual(f.wakes.map(wake => wake.role), ['Foreground','Recorder'])
  assert.equal(f.errors.length, 1)
  await f.loop.poll()
  assert.equal(f.wakes.length, 2)
}))
test('Foreground scheduling failure does not suppress independent Recorder responsibility', () => fixture(async f => {
  const id = '55555555-5555-4555-8555-555555555555'
  await put(f.files, paths.task(id), encodeJson({version:1,taskId:id,route:'P',sourcePath:'tasks/x_P.md',owner:'A',status:'complete'}))
  f.hooks.wake = async request => { if (request.role === 'Foreground') throw new Error('foreground durable admission failed'); f.wakes.push(request) }
  await f.loop.poll()
  assert.deepEqual(f.wakes.map(wake => wake.role), ['Recorder'])
  assert.equal(f.errors.length, 1)
}))

test('released task stops state and cleanup reads on subsequent polls and persisted restart', () => fixture(async f => {
  const id = '66666666-6666-4666-8666-666666666666'
  await put(f.files, paths.task(id), encodeJson({version:1,taskId:id,route:'P',sourcePath:'tasks/x_P.md',owner:'A',status:'complete'}))
  let cleanupReads = 0
  f.hooks.clean = async (task, snapshot) => { cleanupReads++; await f.files.read(snapshot, paths.state('A',task.taskId)+'/Cleaner'); return true }
  await f.loop.poll()
  assert.equal(cleanupReads, 1)
  const read = f.files.read.bind(f.files), accessed: string[] = []
  f.files.read = async (snapshot,path) => { accessed.push(path); return read(snapshot,path) }
  await f.loop.poll(); await f.loop.poll()
  assert.equal(cleanupReads, 1)
  assert.ok(!accessed.some(path => path.startsWith('state/A/'+id) || path.startsWith('task-runs/'+id)))
  await f.loop.start() // Reloads the durable loop record rather than retaining only an in-memory flag.
  assert.equal(cleanupReads, 1)
}))

test('consumed and reposted same-name empty Worker notification has a new revision-based arrangement identity',()=>fixture(async f=>{
  const path='state/Worker_A_Direct_same'
  await put(f.files,path,'');await f.loop.poll()
  const first=f.wakes[0]!.id
  await withSnapshot(f.files,snapshot=>f.files.commit(snapshot,[{path,content:null}],'recipient takeover'))
  await put(f.files,path,'');await f.loop.poll()
  assert.equal(f.wakes.length,2);assert.notEqual(f.wakes[1]!.id,first)
}))

test('invited Host releases only its local Task association after the principal shared cleanup receipt', async () => {
  for (const phase of ['files-cleaned', 'released'] as const) await fixture(async f => {
    const { FrameworkCleaner, captureCleanupInputs, captureCleanupReferences } = await import('../src/framework/cleaner.js')
    const id = '55555555-5555-4555-8555-555555555555', associations = new Set([id])
    const metadata: TaskMetadata = { version: 1, taskId: id, route: 'O', sourcePath: 'tasks/old_O.md', owner: 'A', members: ['A', 'B'], status: 'complete' }
    const memoryStorage = (): StoragePort => {
      const values = new Map<string, unknown>()
      return { get: async key => structuredClone(values.get(key)) as any, set: async (key, value) => { values.set(key, structuredClone(value)) },
        list: async prefix => [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as any })) }
    }
    const aStorage = memoryStorage(), bStorage = memoryStorage(), aTx = new FrameworkTransactions(f.files, aStorage, 'A')
    let releases = 0, sharedCleanCalls = 0
    const archive = paths.archive(id) + '/records.md'
    await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [
      { path: paths.task(id), content: encodeJson(metadata) },
      { path: archive, content: 'Recorder long-term outcome' },
      { path: paths.archive(id) + '/retention.json', content: encodeJson({ outputs: [archive], retainedPaths: [] }) },
      { path: paths.run(id) + '/B/Reply.md', content: 'temporary member record' },
    ], 'completed task pending Recorder cleanup'))
    await withSnapshot(f.files, async snapshot => f.files.commit(snapshot, [{
      path: paths.archive(id) + '/retention.json',
      content: encodeJson({ outputs: [archive], retainedPaths: [], inputs: await captureCleanupInputs(f.files, snapshot, metadata), verifiedReferences: await captureCleanupReferences(f.files, snapshot, [archive]), recorderCommand: 'fixture-recorder-save' }),
    }], 'Recorder records evaluated original material versions'))
    const bHooks = { ...f.hooks, wake: async () => { throw new Error('Invited Host must not wake principal completion roles.') },
      clean: async () => { sharedCleanCalls++; throw new Error('Invited Host must not clean shared files.') },
      releaseTask: async (taskId: string) => { releases++; associations.delete(taskId) } }
    let b = new FrameworkHostLoop(f.files, new FrameworkTransactions(f.files, bStorage, 'B'), bStorage,
      { member: 'B', primary: false, scope: 'B' }, () => ['A', 'B'], bHooks)
    await b.start(); await b.stop()
    assert.equal(associations.has(id), true, 'business complete alone does not release retained Host associations')
    const cleaner = new FrameworkCleaner(f.files, aTx, async () => { if (phase === 'files-cleaned') throw new Error('principal release interrupted') })
    f.hooks.clean = async (task, snapshot) => { const result = await cleaner.clean(task, snapshot); return result.status === 'released' }
    await put(f.files, paths.state('A', id) + '/Cleaner', '')
    await f.loop.poll()
    if (phase === 'files-cleaned') assert.ok(f.errors.some(error => error instanceof Error && /release remains pending/.test(error.message)), 'per-Task isolation reports incomplete release instead of stopping unrelated Tasks')
    await b.start(); await b.stop()
    assert.equal(associations.has(id), false, phase)
    assert.equal(releases, 1)
    assert.equal(sharedCleanCalls, 0)
    b = new FrameworkHostLoop(f.files, new FrameworkTransactions(f.files, bStorage, 'B'), bStorage,
      { member: 'B', primary: false, scope: 'B' }, () => ['A', 'B'], bHooks)
    await b.start(); await b.stop()
    assert.equal(releases, 1, 'persistent completion.released prevents restart resurrection')
    const reads: string[] = [], directories: string[] = [], read = f.files.read.bind(f.files), listDirectory = f.files.listDirectory.bind(f.files)
    f.files.read = async (snapshot, path) => { reads.push(path); return read(snapshot, path) }
    f.files.listDirectory = async (snapshot, prefix) => { directories.push(prefix); return listDirectory(snapshot, prefix) }
    await b.poll(); await b.poll()
    assert.equal(releases, 1)
    assert.equal(sharedCleanCalls, 0)
    assert.equal(reads.some(path => path === 'technical/cleanup/' + id + '.json' || path.startsWith(paths.state('B', id))), false, 'released invited Host no longer reads old cleanup/state')
    assert.equal(directories.some(path => path.startsWith(paths.state('B', id))), false, 'released invited Host does not enumerate old Task signals')
    await withSnapshot(f.files, async snapshot => {
      assert.equal(await f.files.read(snapshot, archive), 'Recorder long-term outcome')
      assert.equal(await f.files.read(snapshot, paths.run(id) + '/B/Reply.md'), undefined)
    })
  })
})

test('invited Host does not record release before its local release callback succeeds', () => fixture(async f => {
  const id = '66666666-6666-4666-8666-666666666666'
  await put(f.files, paths.task(id), encodeJson({ version: 1, taskId: id, route: 'O', sourcePath: 'tasks/old_O.md', owner: 'A', members: ['A', 'B'], status: 'complete' }))
  await put(f.files, 'technical/cleanup/' + id + '.json', encodeJson({ version: 1, taskId: id, phase: 'files-cleaned', retentionHash: 'checked', deletedPaths: [], preservedPaths: [] }))
  let attempts = 0
  f.hooks.releaseTask = async () => { if (++attempts === 1) throw new Error('local association release interrupted') }
  await f.loop.poll()
  assert.equal(attempts, 1)
  assert.equal(f.errors.length, 1)
  await f.loop.poll(); await f.loop.poll()
  assert.equal(attempts, 2)
  assert.ok(!f.actions.includes('clean'))
}, 'B'))

test('Host poll isolates corrupt Task metadata and never schedules from a superseded valid cache', () => fixture(async f => {
  const bad = 'bad-task', good = 'good-task'
  for (const taskId of [bad, good]) {
    await put(f.files, paths.task(taskId), encodeJson({ version: 1, taskId, route: 'P', sourcePath: 'tasks/' + taskId + '_P.md', owner: 'A', status: 'running' }))
    await put(f.files, paths.state('A', taskId) + '/Planner_Foreground', '')
  }
  await f.loop.poll()
  assert.deepEqual(f.wakes.map(wake => wake.taskId).sort(), [bad, good])
  f.wakes.length = 0
  await put(f.files, paths.task(bad), '{malformed metadata')
  await f.loop.poll(); await f.loop.poll()
  assert.ok(f.wakes.length > 0)
  assert.ok(f.wakes.every(wake => wake.taskId === good))
  assert.equal(f.errors.filter(error => error instanceof Error && error.message.includes(paths.task(bad))).length, 1, 'same malformed version diagnostic is retained once')
  await withSnapshot(f.files, async snapshot => assert.equal(await f.files.read(snapshot, paths.state('A', bad) + '/Planner_Foreground'), '', 'bad T notification remains untouched'))
}))

test('Host poll isolates one Task bad member status while delivering another Task notification', () => fixture(async f => {
  const bad = 'bad-status', good = 'good-status'
  for (const taskId of [bad, good]) {
    await put(f.files, paths.task(taskId), encodeJson({ version: 1, taskId, route: 'P', sourcePath: 'tasks/' + taskId + '_P.md', owner: 'A', status: 'running' }))
    await put(f.files, paths.inbox(taskId, 'A'), 'Original pending work ' + taskId)
    await put(f.files, paths.memberStatus(taskId, 'A'), taskId === bad ? '{broken status' : encodeJson({ state: 'running', deliveryId: 'original' }))
  }
  await f.loop.poll(); await f.loop.poll()
  assert.ok(f.wakes.some(wake => wake.taskId === good && wake.role === 'Planner'))
  assert.ok(f.wakes.every(wake => wake.taskId !== bad))
  assert.ok(f.errors.some(error => error instanceof Error && error.cause instanceof SyntaxError && error.message.includes(paths.memberStatus(bad, 'A'))), 'actual status parse cause and affected path reach Host diagnostics')
  await withSnapshot(f.files, async snapshot => assert.equal(await f.files.read(snapshot, paths.state('A', bad) + '/Planner_Inbox'), undefined))
}))

test('Host poll reports rather than swallowing global snapshot and directory capability failure', () => fixture(async f => {
  const snapshot = f.files.snapshot.bind(f.files)
  f.files.snapshot = async () => { throw new Error('Global snapshot unavailable') }
  await assert.rejects(f.loop.poll(), /Global snapshot unavailable/)
  f.files.snapshot = snapshot
  const list = f.files.listDirectory.bind(f.files)
  f.files.listDirectory = async (view, prefix) => { if (prefix === 'tasks/') throw new Error('Global Task directory unavailable'); return list(view, prefix) }
  await assert.rejects(f.loop.poll(), /Global Task directory unavailable/)
  f.files.listDirectory = list
  await put(f.files, 'state/Planner_A_Direct_after-io', '')
  await f.loop.poll()
  assert.ok(f.wakes.some(wake => wake.role === 'Planner'), 'the same loop recovers after real IO capability returns')
}))

test('Host poll rejects an existing malformed member status shape but leaves other Task notification live', () => fixture(async f => {
  for (const taskId of ['bad-shape', 'good-shape']) {
    await put(f.files, paths.task(taskId), encodeJson({ version: 1, taskId, route: 'P', sourcePath: 'tasks/' + taskId + '_P.md', owner: 'A', status: 'running' }))
    await put(f.files, paths.inbox(taskId, 'A'), 'Pending original work')
    await put(f.files, paths.memberStatus(taskId, 'A'), encodeJson({ state: taskId === 'bad-shape' ? 'not-a-state' : 'running', deliveryId: '' }))
  }
  await f.loop.poll(); await f.loop.poll()
  assert.ok(f.wakes.some(wake => wake.taskId === 'good-shape' && wake.role === 'Planner'))
  assert.ok(f.wakes.every(wake => wake.taskId !== 'bad-shape'))
  assert.ok(f.errors.some(error => error instanceof Error && error.message.includes(paths.memberStatus('bad-shape', 'A'))))
}))

// Two real HostLoop instances and Cleaner over shared LocalFiles, with separate
// technical StoragePorts. Role wake/release callbacks are observed boundaries:
// this is not an AgentLoop execution or a complete multi-instance business chain.
test('two Hosts retire T1 while T2 member work survives byte-for-byte and remains schedulable after restart', () => fixture(async f => {
  const { FrameworkCleaner, captureCleanupInputs, captureCleanupReferences } = await import('../src/framework/cleaner.js')
  const { discoverInbox } = await import('../src/framework/task-files.js')
  const retired = '77777777-7777-4777-8777-777777777777', live = '88888888-8888-4888-8888-888888888888'
  const metadata = (taskId: string, status: 'running' | 'complete'): TaskMetadata => ({ version: 1, taskId, route: 'O',
    sourcePath: 'tasks/' + taskId + '_O.md', owner: 'A', members: ['A', 'B'], status })
  const t1 = metadata(retired, 'complete'), t2 = metadata(live, 'running')
  const archive = paths.archive(retired) + '/records.md', bState = paths.state('B', live)
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [
    { path: paths.task(retired), content: encodeJson(t1) },
    { path: t1.sourcePath, content: 'Task ID: ' + retired + '\nFinished requirement' },
    { path: paths.member(retired, 'B') + '/Reply.md', content: 'T1 temporary result' },
    { path: archive, content: 'T1 retained Recorder output' },
    { path: paths.state('A', retired) + '/Cleaner', content: '' },
    { path: paths.task(live), content: encodeJson(t2) },
    { path: t2.sourcePath, content: 'Task ID: ' + live + '\nStill running requirement' },
    { path: paths.inbox(live, 'B'), content: 'B must continue T2, not T1' },
    { path: paths.memberStatus(live, 'B'), content: encodeJson({ state: 'running', deliveryId: 'original-T2' }) },
    { path: paths.run(live) + '/Organizer_Note.md', content: 'T2 waits for B; do not retire' },
    { path: paths.member(live, 'B') + '/Planner_Memory.md', content: 'T2 B current acceptance facts' },
    { path: paths.member(live, 'B') + '/Reply.md', content: 'T2 B long history\n' },
    { path: paths.member(live, 'B') + '/workers/shared-child/notes.md', content: 'T2 in-progress Worker notes' },
    { path: bState + '/Planner_Foreground', content: '' },
  ], 'T1 ready to retire while T2 is still assigned to B'))
  await withSnapshot(f.files, async snapshot => f.files.commit(snapshot,
    await discoverInbox(f.files, snapshot, live, 'B'), 'Establish actual T2 Inbox observation'))
  await withSnapshot(f.files, async snapshot => f.files.commit(snapshot, [{
    path: paths.archive(retired) + '/retention.json',
    content: encodeJson({ outputs: [archive], retainedPaths: [], inputs: await captureCleanupInputs(f.files, snapshot, t1), verifiedReferences: await captureCleanupReferences(f.files, snapshot, [archive]), recorderCommand: 'two-task-recorder-save' }),
  }], 'Recorder verifies T1 only'))
  const liveBodies = await withSnapshot(f.files, async snapshot => {
    const pathsToRead = [paths.task(live), t2.sourcePath, ...(await f.files.list(snapshot, paths.run(live))).map(entry => entry.path),
      ...(await f.files.list(snapshot, bState)).map(entry => entry.path), paths.inbox(live, 'B')]
    return new Map(await Promise.all([...new Set(pathsToRead)].map(async path => [path, await f.files.read(snapshot, path)] as const)))
  })
  const storage = (): StoragePort => {
    const values = new Map<string, unknown>()
    return { get: async key => structuredClone(values.get(key)) as any, set: async (key, value) => { values.set(key, structuredClone(value)) },
      list: async prefix => [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as any })) }
  }
  const aStorage = storage(), bStorage = storage(), releases: string[] = [], wakes: Array<{ member: string; wake: RoleWake }> = [], errors: unknown[] = []
  const associations = { A: new Set([retired, live]), B: new Set([retired, live]) }
  const release = async (member: 'A' | 'B', taskId: string) => { releases.push(member + ':' + taskId); associations[member].delete(taskId) }
  const aTx = new FrameworkTransactions(f.files, aStorage, 'two-task-A')
  const cleaner = new FrameworkCleaner(f.files, aTx, task => release('A', task.taskId))
  const make = (member: 'A' | 'B') => {
    const records = member === 'A' ? aStorage : bStorage
    return new FrameworkHostLoop(f.files, member === 'A' ? aTx : new FrameworkTransactions(f.files, records, 'two-task-B'), records,
      { member, primary: member === 'A', scope: 'two-task-' + member }, () => ['A', 'B'], {
        ...f.hooks, error: error => errors.push(error), executing: () => false,
        wake: async wake => { wakes.push({ member, wake }) }, releaseTask: taskId => release(member, taskId),
        clean: async (task, snapshot) => {
          assert.equal(member, 'A', 'B must not clean shared Task files')
          assert.equal(task.taskId, retired)
          return (await cleaner.clean(task, snapshot)).status === 'released'
        },
      })
  }
  let a = make('A'), b = make('B')
  try {
    await a.poll(); await b.poll(); await a.poll(); await b.poll()
    assert.deepEqual(releases.sort(), ['A:' + retired, 'B:' + retired])
    assert.deepEqual([...associations.A], [live]); assert.deepEqual([...associations.B], [live])
    assert.ok(wakes.some(({ member, wake }) => member === 'B' && wake.taskId === live && wake.role === 'Planner'))
    const assertPreserved = () => withSnapshot(f.files, async snapshot => {
      for (const [path, body] of liveBodies) assert.equal(await f.files.read(snapshot, path), body, 'T2 unchanged: ' + path)
      assert.equal((await readJson<TaskMetadata>(f.files, snapshot, paths.task(live)))!.status, 'running')
      assert.equal(await f.files.read(snapshot, paths.member(retired, 'B') + '/Reply.md'), undefined)
      assert.equal(await f.files.read(snapshot, archive), 'T1 retained Recorder output')
    })
    await assertPreserved()
    await a.stop(); await b.stop()
    a = make('A'); b = make('B'); wakes.length = 0
    await a.start(); await a.stop(); await b.start(); await b.stop()
    await a.poll(); await b.poll()
    assert.equal(releases.length, 2, 'durable T1 release is not repeated on reconstructed Hosts')
    assert.ok(wakes.every(({ wake }) => wake.taskId !== retired), 'retired T1 cannot be reopened by restart')
    assert.ok(wakes.some(({ member, wake }) => member === 'B' && wake.taskId === live && wake.role === 'Planner'), 'T2 pending notification still reaches its own Host')
    await assertPreserved()
    assert.deepEqual(errors, [])
  } finally { await a.stop(); await b.stop() }
}))


test('one poll lends a single post-maintenance snapshot to discovery and task decisions', () => fixture(async f => {
  let count = 0, lent: unknown
  const snapshot = f.files.snapshot.bind(f.files)
  f.files.snapshot = async () => { count++; return snapshot() }
  f.hooks.observe = async () => {
    await put(f.files, 'state/Worker_A_Direct_after-maintenance', '')
  }
  ;(f.hooks as any).discover = async (current: any) => {
    lent = current
    assert.equal(await f.files.read(current, 'state/Worker_A_Direct_after-maintenance'), '')
  }
  const list = f.files.listDirectory.bind(f.files)
  f.files.listDirectory = async (current, path) => {
    if (path === 'tasks/' || path === 'state/') assert.equal(current, lent)
    return list(current, path)
  }
  await f.loop.poll()
  assert.equal(count, 2, 'one maintenance write snapshot and one shared observation snapshot')
  assert.equal(f.wakes[0]?.workerId, 'after-maintenance')
  await assert.rejects(f.files.read(lent as any, 'state/Worker_A_Direct_after-maintenance'), /snapshot/i)
}))


test('failed acquisition reports the lost discovery interval instead of calling discovery with a stale view', () => fixture(async f => {
  const snapshot = f.files.snapshot.bind(f.files)
  let interrupted = 0, discoveries = 0
  f.hooks.discoveryInterrupted = () => { interrupted++ }
  f.hooks.discover = async () => { discoveries++ }
  f.files.snapshot = async () => { throw new Error('remote unavailable') }
  await assert.rejects(f.loop.poll(), /remote unavailable/)
  assert.equal(interrupted, 1)
  assert.equal(discoveries, 0)
  f.files.snapshot = snapshot
  await f.loop.poll()
  assert.equal(discoveries, 1)
}))

test('busy Organizer completion discovery uses signal metadata, not empty marker bodies', () => fixture(async f => {
  const taskId='completion-metadata'
  await put(f.files,paths.task(taskId),encodeJson({version:1,taskId,route:'O',owner:'A',sourcePath:'tasks/completion_O.md',status:'running',members:['A','B']}))
  await put(f.files,paths.state('A',taskId)+'/complete','')
  await put(f.files,paths.state('B',taskId)+'/complete','')
  const read=f.files.read.bind(f.files); let bodyReads=0
  f.files.read=async(snapshot,path)=>{if(path.endsWith('/complete'))bodyReads++;return read(snapshot,path)}
  f.busy(true); await f.loop.poll(); await f.loop.poll()
  assert.equal(bodyReads,0)
  f.busy(false); await f.loop.poll()
  assert.equal(f.wakes.find(row=>row.role==='Organizer')?.sources.length,2)
  assert.equal(bodyReads,0)
}))

test('stopping during maintenance prevents a new discovery request after maintenance settles', () => fixture(async f => {
  let release!:()=>void, entered!:()=>void
  const gate=new Promise<void>(r=>{release=r}), started=new Promise<void>(r=>{entered=r})
  f.hooks.observe=async()=>{entered();await gate}
  let snapshots=0;const snapshot=f.files.snapshot.bind(f.files)
  f.files.snapshot=async()=>{snapshots++;return snapshot()}
  const poll=f.loop.poll();await started
  const stopped=f.loop.stop();release();await Promise.all([poll,stopped])
  assert.equal(snapshots,0)
}))

test('stopping during shared discovery does not start task enumeration afterwards',()=>fixture(async f=>{
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
  f.hooks.discover=async()=>{entered.resolve();await release.promise}
  let lists=0;const list=f.files.listDirectory.bind(f.files)
  f.files.listDirectory=async(snapshot,path)=>{lists++;return list(snapshot,path)}
  const polling=f.loop.poll();await entered.promise
  const stopped=f.loop.stop();release.resolve();await Promise.all([polling,stopped])
  assert.equal(lists,0)
}))

test('fresh Host loop honors explicit cleared-history receipt before completion notifications and persists local release', () => fixture(async f => {
  const cleared = 'a1111111-1111-4111-8111-111111111111', running = 'b2222222-2222-4222-8222-222222222222'
  const receiptPath = 'technical/cleanup/' + cleared + '.json'
  const artifact = paths.archive(cleared) + '/retained-result.bin'
  const bytes = new Uint8Array([0, 255, 128, 10, 1])
  await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [
    { path: paths.task(cleared), content: encodeJson({ version: 1, taskId: cleared, route: 'P', sourcePath: 'tasks/cleared_P.md', owner: 'A', status: 'complete', resultPaths: [artifact] }) },
    { path: receiptPath, content: encodeJson({ version: 1, taskId: cleared, phase: 'released', historyCleared: true, retentionHash: 'verified-before-user-clear', deletedPaths: [paths.archive(cleared) + '/records.md'], preservedPaths: [artifact], preservedArtifacts: [artifact] }) },
    { path: artifact, bytes },
    { path: paths.task(running), content: encodeJson({ version: 1, taskId: running, route: 'P', sourcePath: 'tasks/active_P.md', owner: 'A', status: 'running' }) },
    { path: paths.state('A', running) + '/' + workerWakeSignal('active-child'), content: '' },
  ], 'synthetic completed receipt and independent active task'))
  const values = new Map<string, unknown>()
  const storage: StoragePort = { get: async key => structuredClone(values.get(key)) as never, set: async (key, value) => { values.set(key, structuredClone(value)) }, list: async prefix => [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) as never }
  const wakes: RoleWake[] = [], released: string[] = [], errors: unknown[] = []
  const actions: HostLoopActions = { startup: async () => {}, observe: async () => {}, executing: () => false,
    wake: async wake => { wakes.push(wake) }, releaseTask: async id => { released.push(id) },
    sealBusiness: async task => { assert.notEqual(task.taskId, cleared, 'Cleared history must not re-enter business sealing') },
    clean: async task => { assert.notEqual(task.taskId, cleared, 'Explicitly cleared history must not run Cleaner again') }, error: error => errors.push(error) }
  const reads: string[] = [], directories: string[] = [], read = f.files.read.bind(f.files), list = f.files.listDirectory.bind(f.files)
  f.files.read = async (snapshot, path) => { reads.push(path); return read(snapshot, path) }
  f.files.listDirectory = async (snapshot, path) => { directories.push(path); return list(snapshot, path) }
  const makeLoop = () => new FrameworkHostLoop(f.files, new FrameworkTransactions(f.files, storage, 'fresh-local'), storage, { member: 'A', primary: true, scope: 'fresh-local' }, () => ['A'], actions)
  const first = makeLoop()
  try { await first.start(); await first.poll() } finally { await first.stop() }
  assert.deepEqual(wakes.filter(wake => wake.taskId === cleared).map(wake => wake.role), [], 'No Foreground/Recorder may rebuild explicitly cleared Task history')
  assert.deepEqual(errors, [])
  assert.deepEqual(released, [cleared])
  assert.ok(wakes.some(wake => wake.taskId === running && wake.role === 'Worker'))
  assert.equal(reads.filter(path => path === receiptPath).length, 1)
  const restarted = makeLoop()
  try { await restarted.start(); await restarted.poll() } finally { await restarted.stop() }
  assert.deepEqual(released, [cleared], 'Local release association survives Host reconstruction')
  assert.equal(reads.filter(path => path === receiptPath).length, 1, 'Released old Task receipt is not polled again')
  assert.ok(!directories.some(path => path.startsWith(paths.state('A', cleared))))
  await withSnapshot(f.files, async snapshot => assert.deepEqual(await f.files.readBytes(snapshot, artifact), bytes))
}))

for (const change of [
  { historyCleared: false }, { historyCleared: 'true' }, { version: 2 },
  { taskId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }, { phase: 'files-cleaned' },
]) test('non-authoritative cleared-history receipt does not suppress completion: ' + JSON.stringify(change), () => fixture(async f => {
  const id = 'c3333333-3333-4333-8333-333333333333'
  await put(f.files, paths.task(id), encodeJson({ version: 1, taskId: id, route: 'P', sourcePath: 'tasks/old_P.md', owner: 'A', status: 'complete' }))
  await put(f.files, 'technical/cleanup/' + id + '.json', encodeJson({ version: 1, taskId: id, phase: 'released', historyCleared: true, retentionHash: 'existing', deletedPaths: [], preservedPaths: [], ...change }))
  await f.loop.poll()
  assert.deepEqual(f.wakes.map(wake => wake.role), ['Foreground', 'Recorder'])
  assert.ok(!f.actions.includes('release'))
}))

test('cleared-history local release failure retains responsibility without recreating completion notifications', () => fixture(async f => {
  const id = 'd4444444-4444-4444-8444-444444444444'
  await put(f.files, paths.task(id), encodeJson({ version: 1, taskId: id, route: 'O', sourcePath: 'tasks/old_O.md', owner: 'A', status: 'complete' }))
  await put(f.files, 'technical/cleanup/' + id + '.json', encodeJson({ version: 1, taskId: id, phase: 'released', historyCleared: true, retentionHash: 'checked', deletedPaths: [], preservedPaths: [] }))
  let attempts = 0
  f.hooks.releaseTask = async taskId => { assert.equal(taskId, id); if (++attempts === 1) throw new Error('Local release not yet persisted') }
  await f.loop.poll()
  assert.equal(attempts, 1)
  assert.equal(f.errors.length, 1)
  assert.deepEqual(f.wakes, [])
  await f.loop.poll(); await f.loop.poll()
  assert.equal(attempts, 2)
  assert.deepEqual(f.wakes, [])
  assert.ok(!f.actions.includes('seal') && !f.actions.includes('clean'))
}))

test('cold Local Host cannot initialize or schedule a running Task whose cancelled history was explicitly cleared', () => fixture(async f => {
  const id = 'a5555555-5555-4555-8555-555555555555', other = 'b6666666-6666-4666-8666-666666666666', source = 'tasks/cancelled_O.md'
  await withSnapshot(f.files, s => f.files.commit(s, [
    { path: source, content: 'Task ID: ' + id + '\nOriginal cancelled work' },
    { path: paths.task(id), content: encodeJson({ version: 1, taskId: id, route: 'O', sourcePath: source, owner: 'A', status: 'running' }) },
    { path: 'technical/cleanup/' + id + '.json', content: encodeJson({ version: 1, taskId: id, phase: 'released', historyCleared: true, retentionHash: 'user-cleared', deletedPaths: [], preservedPaths: [] }) },
    { path: paths.state('A', id) + '/Organizer_Foreground', content: '' },
    { path: paths.state('A', id) + '/Planner_Inbox', content: '' },
    { path: paths.state('A', id) + '/' + workerWakeSignal('old-child'), content: '' },
    { path: paths.task(other), content: encodeJson({ version: 1, taskId: other, route: 'P', sourcePath: 'tasks/other_P.md', owner: 'A', status: 'running' }) },
    { path: paths.state('A', other) + '/' + workerWakeSignal('other-child'), content: '' },
  ], 'cancelled and manually cleared fixture'))
  const reads: string[] = [], directories: string[] = [], read = f.files.read.bind(f.files), list = f.files.listDirectory.bind(f.files)
  f.files.read = async (snapshot, path) => { reads.push(path); return read(snapshot, path) }
  f.files.listDirectory = async (snapshot, path) => { directories.push(path); return list(snapshot, path) }
  await f.loop.poll(); await f.loop.poll()
  assert.equal(reads.filter(path => path === source).length, 1, 'source identity is checked once without re-entering initialization or polling old state')
  assert.equal(f.wakes.some(wake => wake.taskId === id), false)
  assert.equal(directories.some(path => path.startsWith(paths.state('A', id))), false)
  assert.equal(reads.some(path => path.startsWith(paths.run(id) + '/')), false, 'no old Inbox or runtime body is observed')
  assert.ok(f.wakes.some(wake => wake.taskId === other && wake.role === 'Worker'))
  assert.equal((await withSnapshot(f.files, s => readJson<TaskMetadata>(f.files, s, paths.task(id))))!.status, 'running', 'cancelled is not fabricated as complete')
  assert.equal(f.actions.filter(action => action === 'release').length, 1)
}))

test('a reused source filename with a new explicit Task ID initializes the new Task after manual history cleanup', () => fixture(async f => {
  const old = 'a7777777-7777-4777-8777-777777777777', fresh = 'b8888888-8888-4888-8888-888888888888', source = 'tasks/reused_P.md'
  await withSnapshot(f.files, s => f.files.commit(s, [
    { path: source, content: 'Task ID: ' + fresh + '\nA genuinely new request' },
    { path: paths.task(old), content: encodeJson({ version: 1, taskId: old, route: 'P', sourcePath: source, owner: 'A', status: 'running' }) },
    { path: 'technical/cleanup/' + old + '.json', content: encodeJson({ version: 1, taskId: old, phase: 'released', historyCleared: true, retentionHash: 'manual', deletedPaths: [], preservedPaths: [] }) },
  ], 'new Task identity reuses prior filename'))
  await f.loop.poll(); await f.loop.poll(); await f.loop.poll()
  const task = await withSnapshot(f.files, s => readJson<TaskMetadata>(f.files, s, paths.task(fresh)))
  assert.equal(task!.taskId, fresh)
  assert.ok(f.wakes.some(wake => wake.taskId === fresh && wake.role === 'Planner'))
  assert.equal(f.wakes.some(wake => wake.taskId === old), false)
}))

function phaseBarrier() {
  let release!: () => void, enter!: () => void
  return { waiting: new Promise<void>(resolve => { release = resolve }), entered: new Promise<void>(resolve => { enter = resolve }),
    release: () => release(), enter: () => enter() }
}
const driverSettled = () => new Promise<void>(resolve => setImmediate(resolve))
test('the existing timer persists local observation during one held remote flight without confirming startup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await fixture(async f => {
    const hold = phaseBarrier(); let local = 0, remote = 0, started = false
    f.hooks.observeLocal = async () => { local++ }
    f.hooks.observe = async () => { remote++; hold.enter(); await hold.waiting }
    const starting = f.loop.start().then(() => { started = true })
    await hold.entered
    for (let n = 0; n < 3; n++) { t.mock.timers.tick(1000); await driverSettled() }
    assert.equal(local, 4); assert.equal(remote, 1); assert.equal(started, false)
    let explicitReturned = false
    const explicit = f.loop.poll().then(() => { explicitReturned = true })
    await driverSettled(); assert.equal(local, 5); assert.equal(remote, 1); assert.equal(explicitReturned, false)
    hold.release(); await starting; await explicit
    assert.equal(started, true); assert.deepEqual(f.errors, [])
    // No catch-up burst on settlement: only the next original timer starts work.
    await driverSettled(); assert.equal(remote, 1)
    t.mock.timers.tick(1000); await driverSettled(); assert.equal(remote, 2)
  })
})
test('startup recovery barrier admits neither timer observation nor ordinary remote work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await fixture(async f => {
    const hold = phaseBarrier(); let local = 0, remote = 0
    f.hooks.startup = async () => { hold.enter(); await hold.waiting }
    f.hooks.observeLocal = async () => { local++ }; f.hooks.observe = async () => { remote++ }
    const starting = f.loop.start(); await hold.entered
    t.mock.timers.tick(5000); await driverSettled(); assert.equal(local, 0); assert.equal(remote, 0)
    hold.release(); await starting; assert.equal(local, 1); assert.equal(remote, 1)
  })
})
test('stop drains both owned lanes and prevents late local completion admitting remote work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await fixture(async f => {
    const remote = phaseBarrier(), local = phaseBarrier(); let localCalls = 0, remoteCalls = 0, stopped = false
    f.hooks.observeLocal = async () => { if (++localCalls > 1) { local.enter(); await local.waiting } }
    f.hooks.observe = async () => { remoteCalls++; remote.enter(); await remote.waiting }
    const starting = f.loop.start(); await remote.entered
    t.mock.timers.tick(1000); await local.entered
    const stop = f.loop.stop().then(() => { stopped = true })
    remote.release(); await starting; await driverSettled(); assert.equal(stopped, false)
    local.release(); await stop
    t.mock.timers.tick(5000); await driverSettled(); assert.equal(localCalls, 2); assert.equal(remoteCalls, 1)
  })
})
test('local observation failure is reported without pretending it succeeded or blocking remote discovery', () => fixture(async f => {
  const failure = new Error('local observation persistence failed'); let remote = 0
  f.hooks.observeLocal = async () => { throw failure }; f.hooks.observe = async () => { remote++ }
  await f.loop.poll(); assert.equal(remote, 1); assert.deepEqual(f.errors, [failure])
}))
test('explicit poll and stop retain the exact remote snapshot error, not a cancellation substitute', () => fixture(async f => {
  const hold = phaseBarrier(), failure = new Error('independent remote failure')
  const original = f.files.snapshot.bind(f.files)
  f.files.snapshot = async () => { hold.enter(); await hold.waiting; throw failure }
  const polling = f.loop.poll(); const rejected = assert.rejects(polling, e => e === failure)
  await hold.entered; const stopped = f.loop.stop(); const stopRejected = assert.rejects(stopped, e => e === failure)
  hold.release(); await rejected; await stopRejected; f.files.snapshot = original
}))
test('timer-owned remote failure is reported once and remains drain-owned through stop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await fixture(async f => {
    await f.loop.start()
    const hold = phaseBarrier(), failure = new Error('non-cancellation remote snapshot failure')
    const original = f.files.snapshot.bind(f.files)
    f.files.snapshot = async () => { hold.enter(); await hold.waiting; throw failure }
    t.mock.timers.tick(1000); await hold.entered
    const stopped = f.loop.stop(), rejected = assert.rejects(stopped, e => e === failure)
    hold.release(); await rejected; await driverSettled()
    assert.deepEqual(f.errors, [failure]); f.files.snapshot = original
  })
})
test('stop before the admitted local microtask prevents a not-yet-started observation hook', () => fixture(async f => {
  let local = 0, remote = 0
  f.hooks.observeLocal = async () => { local++ }; f.hooks.observe = async () => { remote++ }
  const poll = f.loop.poll(), stopping = f.loop.stop()
  await Promise.all([poll, stopping]); assert.equal(local, 0); assert.equal(remote, 0)
}))
test('stop at synchronous remote admission drains the already owned observation', () => fixture(async f => {
  const hold = phaseBarrier(); let stopped = false, settled = false, stop: Promise<void> | undefined
  f.hooks.observe = async () => { stop = f.loop.stop().then(() => { stopped = true }); hold.enter(); await hold.waiting; settled = true }
  const poll = f.loop.poll(); await hold.entered
  try { await driverSettled(); assert.equal(settled, false); assert.equal(stopped, false, 'stop must retain the admitted remote operation') }
  finally { hold.release(); await poll; await stop }
}))

test('new durable discovery admits in the same poll only after releasing its borrowed snapshot', () => fixture(async f => {
  await put(f.files, 'state/Planner_A_Direct_immediate', '')
  const snapshot = f.files.snapshot.bind(f.files); let released = false, admissions = 0
  f.files.snapshot = async () => { const view = await snapshot(), release = view.release.bind(view); released = false
    view.release = async () => { await release(); released = true }; return view }
  const persisted = new Set<string>()
  f.hooks.wake = async request => { if (persisted.has(request.id)) return false; persisted.add(request.id); f.wakes.push(request); return true }
  f.hooks.admitDiscovered = async () => { assert.equal(released, true); assert.equal(f.wakes.length, 1); admissions++ }
  await f.loop.poll()
  assert.equal(admissions, 1, 'new durable wake does not wait for the next one-second tick')
  await f.loop.poll()
  assert.equal(admissions, 1, 'deduplicated discovery does not run an extra admission/body pass')
}))

test('discovery snapshot release crossing close never starts a new admission', () => fixture(async f => {
  await put(f.files, 'state/Planner_A_Direct_closing', '')
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  const snapshot = f.files.snapshot.bind(f.files); let admissions = 0
  f.files.snapshot = async () => { const view = await snapshot(), release = view.release.bind(view)
    view.release = async () => { entered.resolve(); await gate.promise; await release() }; return view }
  f.hooks.admitDiscovered = async () => { admissions++ }
  const poll = f.loop.poll(); await entered.promise
  const stopping = f.loop.stop(); gate.resolve(); await Promise.all([poll, stopping])
  assert.equal(f.wakes.length, 1); assert.equal(admissions, 0)
}))

test('same-poll admission remains owned and stop drains its accepted callback', () => fixture(async f => {
  await put(f.files, 'state/Planner_A_Direct_owned', '')
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(); let stopped = false
  f.hooks.admitDiscovered = async () => { entered.resolve(); await gate.promise }
  const poll = f.loop.poll()
  // The preceding test proves invocation separately; avoid waiting forever on the old implementation.
  await Promise.race([entered.promise, poll])
  assert.equal(f.wakes.length, 1)
  const stopping = f.loop.stop().then(() => { stopped = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  try { assert.equal(stopped, false, 'stop must join admission already accepted by this poll') }
  finally { gate.resolve(); await Promise.all([poll, stopping]) }
}))

test('failed snapshot release leaves durable discovery pending rather than admitting against a borrowed view', () => fixture(async f => {
  await put(f.files, 'state/Planner_A_Direct_release_error', '')
  const snapshot = f.files.snapshot.bind(f.files), failure = new Error('snapshot release failed'); let admissions = 0
  f.files.snapshot = async () => { const view = await snapshot(), release = view.release.bind(view)
    view.release = async () => { await release(); throw failure }; return view }
  f.hooks.admitDiscovered = async () => { admissions++ }
  await assert.rejects(f.loop.poll(), error => error === failure)
  assert.equal(f.wakes.length, 1); assert.equal(admissions, 0)
}))

test('total completion batches new Foreground and Recorder receipts into one post-release admission', () => fixture(async f => {
  const taskId = 'admission-complete-task'
  await put(f.files, paths.task(taskId), encodeJson({ version: 1, taskId, route: 'O', sourcePath: 'tasks/source_O.md', owner: 'A', status: 'complete' }))
  let admissions = 0
  f.hooks.admitDiscovered = async () => { admissions++; assert.deepEqual(f.wakes.map(wake => wake.role), ['Foreground', 'Recorder']) }
  await f.loop.poll(); assert.equal(admissions, 1)
  await f.loop.poll(); assert.equal(admissions, 1, 'completion replay does not arrange another admission')
}))

test('uncertain discovery persistence does not claim a newly confirmed wake or suppress its error', () => fixture(async f => {
  await put(f.files, 'state/Planner_A_Direct_uncertain', '')
  const failure = new Error('Wake persistence outcome is unknown'); let admissions = 0
  f.hooks.wake = async () => { throw failure }
  f.hooks.admitDiscovered = async () => { admissions++ }
  await assert.rejects(f.loop.poll(), error => error === failure)
  assert.equal(admissions, 0)
}))

test('accepted post-discovery admission failure remains the original owned poll failure', () => fixture(async f => {
  await put(f.files, 'state/Planner_A_Direct_failed_admission', '')
  const failure = new Error('Native admission failed')
  f.hooks.admitDiscovered = async () => { throw failure }
  await assert.rejects(f.loop.poll(), error => error === failure)
  assert.equal(f.wakes.length, 1, 'durable responsibility is preserved for ordinary recovery')
}))

test('a held Task read cannot block another Task signal or its later poll; close drains that exact lane', () => fixture(async f => {
  for (const taskId of ['held-A', 'ready-B']) await put(f.files, paths.task(taskId), encodeJson({ version: 1, taskId, route: 'P', owner: 'A', status: 'running', sourcePath: 'inputs/' + taskId }))
  const firstSignal = paths.state('A', 'ready-B') + '/Worker_child_Planner'
  await put(f.files, firstSignal, '')
  const gate = phaseBarrier(), read = f.files.readBytes.bind(f.files); let heldReads = 0
  f.files.readBytes = async (snapshot, path) => { if (path === paths.task('held-A')) { heldReads++; gate.enter(); await gate.waiting }; return read(snapshot, path) }
  const polling = f.loop.poll(); await gate.entered
  try {
    await driverSettled()
    assert.ok(f.wakes.some(wake => wake.taskId === 'ready-B' && wake.workerId === 'child'))
    await withSnapshot(f.files, snapshot => f.files.commit(snapshot, [{ path: firstSignal, content: null }, { path: paths.state('A', 'ready-B') + '/Worker_next_Planner', content: '' }], 'next actual notification'))
    await (f.loop as any).drive(); await driverSettled()
    assert.ok(f.wakes.some(wake => wake.taskId === 'ready-B' && wake.workerId === 'next'))
    assert.equal(heldReads, 1, 'one admitted read per Task; ticks never stack duplicate reads')
    let stopped = false
    const stopping = f.loop.stop().then(() => { stopped = true })
    await driverSettled(); assert.equal(stopped, false)
    gate.release(); await Promise.all([polling, stopping]); assert.equal(stopped, true)
  } finally { gate.release(); await polling }
}))

test('a held source header cannot block global signals, another source or later discovery', () => fixture(async f => {
  const source = 'tasks/A_P.md', gate = phaseBarrier(), read = f.files.read.bind(f.files)
  await put(f.files, source, 'held source A')
  await put(f.files, 'tasks/B_O.md', 'independent source B')
  await put(f.files, 'state/Foreground_first', '')
  let reads = 0
  f.files.read = async (snapshot, path) => { if (path === source) { reads++; gate.enter(); await gate.waiting }; return read(snapshot, path) }
  const first = f.loop.poll(); await gate.entered
  try {
    await driverSettled()
    assert.ok(f.wakes.some(wake => wake.sources.some(item => item.path === 'state/Foreground_first')))
    await withSnapshot(f.files, async snapshot => {
      const entries = await f.files.listDirectory(snapshot, 'tasks/')
      const tasks = await Promise.all(entries.filter(entry => entry.path.endsWith('.json')).map(entry => readJson<TaskMetadata>(f.files, snapshot, entry.path)))
      assert.equal(tasks.length, 1); assert.equal(tasks[0]?.sourcePath, 'tasks/B_O.md')
    })
    await put(f.files, 'state/Foreground_later', '')
    await (f.loop as any).drive(); await driverSettled()
    assert.ok(f.wakes.some(wake => wake.sources.some(item => item.path === 'state/Foreground_later')))
    assert.equal(reads, 1, 'ticks do not duplicate the held source read')
    assert.ok(f.wakes.every(wake => !wake.taskId || wake.sources.every(item => item.path !== source)))
  } finally { gate.release(); await first }
  await f.loop.poll(); await f.loop.poll()
  await withSnapshot(f.files, async snapshot => assert.equal((await f.files.listDirectory(snapshot, 'tasks/')).filter(entry => entry.path.endsWith('.json')).length, 2))
  assert.deepEqual(f.errors, [])
}))

test('an admitted source transaction remains atomic and singular across reentry and close', () => fixture(async f => {
  const source = 'tasks/atomic_P.md', gate = phaseBarrier(), commit = f.files.commit.bind(f.files)
  await put(f.files, source, 'exact original requirement')
  let initializations = 0, staged: readonly { path: string; content?: string | null }[] = []
  f.files.commit = async (snapshot, changes, message) => {
    if (changes.some(change => change.path === source)) { initializations++; staged = changes; gate.enter(); await gate.waiting }
    return commit(snapshot, changes, message)
  }
  const first = f.loop.poll(); await gate.entered
  let closing: Promise<void> | undefined, second: Promise<void> | undefined, stopped = false
  try {
    const metadata = staged.find(change => /^tasks\/[^/]+\.json$/.test(change.path))!
    const task = JSON.parse(metadata.content!) as TaskMetadata
    assert.ok(staged.some(change => change.path === paths.inbox(task.taskId, 'A')))
    await withSnapshot(f.files, async snapshot => {
      assert.equal(await f.files.read(snapshot, source), 'exact original requirement')
      assert.equal((await f.files.listDirectory(snapshot, 'tasks/')).filter(entry => entry.path.endsWith('.json')).length, 0)
    })
    second = f.loop.poll(); await driverSettled(); assert.equal(initializations, 1)
    assert.equal(f.wakes.length, 0, 'no business wake before the atomic task transaction')
    closing = f.loop.stop().then(() => { stopped = true })
    await driverSettled(); assert.equal(stopped, false, 'close joins the already dispatched transaction')
  } finally { gate.release(); await Promise.all([first, second, closing]) }
  assert.equal(initializations, 1); assert.equal(f.wakes.length, 0)
  await withSnapshot(f.files, async snapshot => {
    const taskEntry = (await f.files.listDirectory(snapshot, 'tasks/')).find(entry => entry.path.endsWith('.json'))!
    const task = (await readJson<TaskMetadata>(f.files, snapshot, taskEntry.path))!
    assert.equal(await f.files.read(snapshot, source), 'Task ID: ' + task.taskId + '\nexact original requirement')
    assert.equal(await f.files.read(snapshot, paths.inbox(task.taskId, 'A')), 'exact original requirement')
    assert.equal(await f.files.read(snapshot, paths.state('A', task.taskId) + '/Planner_Inbox'), undefined)
  })
  await f.loop.start(); await f.loop.poll()
  assert.ok(f.wakes.some(wake => wake.role === 'Planner')); assert.equal(initializations, 1)
  assert.deepEqual(f.errors, [])
}))

for (const outcome of ['released', 'cancelled'] as const) test(`close during source reading keeps ownership and fences later initialization: ${outcome}`, () => fixture(async f => {
  const source = 'tasks/closing_O.md', gate = phaseBarrier(), read = f.files.read.bind(f.files)
  const cancellation = new DOMException('exact source read cancellation', 'AbortError')
  await put(f.files, source, 'new work after restart')
  f.files.read = async (snapshot, path) => {
    if (path === source) { gate.enter(); await gate.waiting; if (outcome === 'cancelled') throw cancellation }
    return read(snapshot, path)
  }
  const first = f.loop.poll().then(() => undefined, error => error); await gate.entered
  let stopped = false
  const closing = f.loop.stop().then(() => { stopped = true }, error => { stopped = true; return error })
  try { await driverSettled(); assert.equal(stopped, false); assert.equal(f.wakes.length, 0) }
  finally { gate.release() }
  const [pollError, stopError] = await Promise.all([first, closing])
  assert.equal(pollError, outcome === 'cancelled' ? cancellation : undefined)
  assert.equal(stopError, outcome === 'cancelled' ? cancellation : undefined)
  assert.deepEqual(f.errors, outcome === 'cancelled' ? [cancellation] : [])
  f.files.read = read
  await withSnapshot(f.files, async snapshot => {
    assert.equal(await f.files.read(snapshot, source), 'new work after restart')
    assert.equal((await f.files.listDirectory(snapshot, 'tasks/')).filter(entry => entry.path.endsWith('.json')).length, 0)
  })
  await f.loop.start(); await f.loop.poll()
  assert.ok(f.wakes.some(wake => wake.role === 'Organizer'))
}))

test('source assignment save failure stays visible after its lane settles and retries persistence before dispatch', () => fixture(async f => {
  const source = 'tasks/save_P.md', rootGate = phaseBarrier(), failed = phaseBarrier(), failure = new Error('assignment storage refused')
  await put(f.files, source, 'durable assignment first'); await put(f.files, 'state/Foreground_during-failure', '')
  const internal = f.loop as any, records = internal.storage as StoragePort, set = records.set.bind(records), list = f.files.listDirectory.bind(f.files)
  let saves = 0, holdRoot = true
  records.set = async (key, value) => { if (key === internal.key && ++saves <= 2) throw failure; await set(key, value) }
  f.files.listDirectory = async (snapshot, path) => { if (holdRoot && path === 'state/') { rootGate.enter(); await rootGate.waiting }; return list(snapshot, path) }
  f.hooks.error = error => { f.errors.push(error); failed.enter() }
  const first = f.loop.poll(), rejected = assert.rejects(first, error => error === failure)
  await Promise.all([failed.entered, rootGate.entered]); await driverSettled()
  assert.equal(internal.sourceOperations.size, 0, 'failed lane settled before the directory pass returned')
  const assignment = Object.values(internal.record.initial)[0] as { taskId: string }
  holdRoot = false; rootGate.release(); await rejected
  assert.ok(f.wakes.some(wake => wake.role === 'Foreground'))
  assert.equal(await records.get(internal.key), undefined)
  await assert.rejects(f.loop.poll(), error => error === failure)
  await withSnapshot(f.files, async snapshot => assert.equal(await f.files.read(snapshot, paths.task(assignment.taskId)), undefined))
  await f.loop.poll()
  const persisted = await records.get<any>(internal.key)
  assert.equal(Object.values(persisted.initial).length, 1)
  assert.equal((Object.values(persisted.initial)[0] as any).taskId, assignment.taskId)
  await withSnapshot(f.files, async snapshot => assert.equal((await readJson<TaskMetadata>(f.files, snapshot, paths.task(assignment.taskId)))?.sourcePath, source))
  assert.deepEqual(f.errors, [failure, failure])
}))

test('source transaction failure preserves its exact error and assignment while unrelated signals proceed', () => fixture(async f => {
  const source = 'tasks/retry_O.md', failure = new Error('initialization commit refused'), commit = f.files.commit.bind(f.files)
  await put(f.files, source, 'same source responsibility'); await put(f.files, 'state/Foreground_unrelated', '')
  let attempts = 0, firstTask: string | undefined
  f.files.commit = async (snapshot, changes, message) => {
    if (changes.some(change => change.path === source)) {
      const metadata = changes.find(change => /^tasks\/[^/]+\.json$/.test(change.path))!
      if (++attempts === 1) { firstTask = metadata.path; throw failure }
      assert.equal(metadata.path, firstTask)
    }
    return commit(snapshot, changes, message)
  }
  await assert.rejects(f.loop.poll(), error => error === failure)
  assert.deepEqual(f.errors, [failure]); assert.ok(f.wakes.some(wake => wake.role === 'Foreground'))
  assert.ok(f.wakes.every(wake => !wake.taskId), 'failed initialization cannot publish a business wake')
  await withSnapshot(f.files, async snapshot => assert.equal(await f.files.read(snapshot, firstTask!), undefined))
  await f.loop.poll(); await f.loop.poll()
  assert.equal(attempts, 2); assert.ok(f.wakes.some(wake => wake.role === 'Organizer'))
}))
