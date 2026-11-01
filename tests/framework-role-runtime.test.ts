import { FilesOutcomeUnknownError } from '../src/framework/transactions.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ExecutionControls } from '../src/framework/execution-control.js'
import { FrameworkRoleRuntime } from '../src/framework/role-runtime.js'
import type { ScheduledObservation } from '../src/framework/execution-observation.js'

// Composition queue seam only: these do not claim a running native Host or model.
function queue() {
  const rows = new Map<string, any>()
  const runtime = Object.create(FrameworkRoleRuntime.prototype) as any
  runtime.prefix = 'test/'
  runtime.environment = {}
  runtime.records = { get: async (key: string) => structuredClone(rows.get(key)),
    set: async (key: string, value: unknown) => { rows.set(key, structuredClone(value)) },
    list: async (prefix: string) => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key,value]) => ({key,value:structuredClone(value)})) }
  runtime.controls = new ExecutionControls(runtime.records, 'fixture')
  return { runtime, rows }
}
const pending: ScheduledObservation = { id: 'execution-stage', cycleStartedAt: 0, checkedAt: 300000, progressAt: 0,
  action: { kind: 'probe-helper', stage: 1, elapsedMs: 300000, silentMs: 300000,
    identity: { role: 'Helper', workId: 'helper', executionId: 'e1' } } }

test('tick arrangement is durable admission only, execution runs after queue returns and replay stays completed', async () => {
  const { runtime } = queue()
  let insideTick = true, called = 0
  runtime.arrangeObservation = async () => { assert.equal(insideTick, false); called++ }
  await runtime.enqueueObservation(pending)
  assert.equal(called, 0)
  insideTick = false
  await runtime.processObservations()
  await runtime.enqueueObservation(pending)
  await runtime.processObservations()
  assert.equal(called, 1)
})
test('failed queued execution keeps the same scheduled identity for retry', async () => {
  const { runtime } = queue(), attempts: string[] = []
  runtime.arrangeObservation = async (item: ScheduledObservation) => { attempts.push(item.id); if (attempts.length === 1) throw new Error('stop unconfirmed') }
  await runtime.enqueueObservation(pending)
  await assert.rejects(runtime.processObservations(), /stop unconfirmed/)
  await runtime.processObservations()
  assert.deepEqual(attempts, [pending.id, pending.id])
})
test('queued helper probe rechecks actual execution progress before delivering', async () => {
  const { runtime } = queue()
  runtime.observations = { mayApply: async () => false }
  runtime.native = { get: () => { throw new Error('stale action reached native execution') } }
  await runtime.enqueueObservation(pending)
  await runtime.processObservations()
})

test('unowned native registry absence cannot confirm a previously unconfirmed producer stop', async () => {
  const { runtime } = queue()
  const record = { identity: {workId:'w',executionId:'e',role:'Worker'},sessionId:'native-s',generation:1,
    stopUnknown:{reason:'producer did not report settlement',jobs:['job-1']} }
  runtime.native = { stop: async () => ({status:'superseded'}) }
  runtime.roleRecords = new Map([['w',record]])
  runtime.ctx = {agents:{get:()=>undefined},jobs:{list:()=>[]}}
  const result = await runtime.stopOwnedRecord(record)
  assert.equal(result.status,'unconfirmed'); assert.deepEqual(result.jobs,['job-1'])
})
test('a surviving native Agent without this runtime handle is not marked stopped', async () => {
  const { runtime } = queue()
  const record = {identity:{workId:'w',executionId:'e',role:'Worker'},sessionId:'native-s',generation:1}
  runtime.native = {stop:async()=>({status:'superseded'})}; runtime.roleRecords = new Map([['w',record]])
  runtime.ctx = {agents:{get:()=>({status:'idle'})},jobs:{list:()=>[]}}
  assert.equal((await runtime.stopOwnedRecord(record)).status,'unconfirmed')
})
test('Host errors durably arrange Helper without recursively reentering diagnostic failure', async () => {
  const { runtime, rows } = queue(), reports: unknown[] = []
  runtime.closed = false; runtime.errorTail = Promise.resolve(); runtime.environment = {error:(error:unknown)=>reports.push(error)}
  runtime.error(new Error('storage unavailable')); runtime.error(new Error('storage unavailable'))
  await runtime.errorTail
  assert.equal(reports.length,2)
  const wakes = [...rows.values()].filter(row=>row.request)
  assert.equal(wakes.length,1); assert.equal(wakes[0].request.role,'Helper')
  runtime.records.set = async () => {throw new Error('diagnostic storage unavailable')}
  runtime.error(new Error('new fault')); await runtime.errorTail
  assert.equal(reports.length,4)
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFiles } from '../src/framework/local-files.js'
import { withSnapshot, FilesConflictError } from '../src/framework/transactions.js'
import { paths, encodeJson } from '../src/framework/task-files.js'
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
test('Helper overall restoration uses actual same-snapshot Inbox eligibility and preserves all business bodies',async t=>{
  const {runtime,files,storage}=await runtimeFixture(t),taskId='11111111-1111-4111-8111-111111111111'
  await withSnapshot(files,snapshot=>files.commit(snapshot,[
    {path:paths.task(taskId),content:encodeJson({version:1,taskId,route:'O',owner:'A',sourcePath:'tasks/work_O.md',status:'running',members:['A','B','empty','completed']})},
    ...['A','B','empty','completed'].flatMap(member=>[
      {path:paths.inbox(taskId,member),content:member==='empty'?'':'preserved '+member},
      {path:paths.memberStatus(taskId,member),content:encodeJson({state:member==='completed'?'complete':'running',deliveryId:''})},
    ]),
  ],'preexisting work'))
  await storage.set(runtime.prefix+'host-restores/command',{commandId:'restore-all',createdAt:'2026-10-31T00:00:00Z',input:{facts:'failed',hypotheses:'unknown',actionsTaken:'preserved',continuation:'inspect'},complete:false})
  await runtime.processHostRestores()
  await withSnapshot(files,async snapshot=>{
    for(const member of ['A','B'])assert.equal(await files.read(snapshot,paths.state(member,taskId)+'/recovery'),'')
    for(const member of ['empty','completed'])assert.equal(await files.read(snapshot,paths.state(member,taskId)+'/recovery'),undefined)
    assert.equal(await files.read(snapshot,paths.state('A',taskId)+'/Organizer_Helper'),'')
    assert.equal(await files.read(snapshot,paths.inbox(taskId,'completed')),'preserved completed')
    assert.equal(await files.read(snapshot,paths.inbox(taskId,'B')),'preserved B')
  })
})
test('member completion winning before recovery publication prevents a new marker on the completed member',async t=>{
  const {runtime,files,storage}=await runtimeFixture(t),taskId='22222222-2222-4222-8222-222222222222'
  await withSnapshot(files,snapshot=>files.commit(snapshot,[
    {path:paths.task(taskId),content:encodeJson({version:1,taskId,route:'O',owner:'A',sourcePath:'tasks/work_O.md',status:'running',members:['A']})},
    {path:paths.inbox(taskId,'A'),content:'preserved'}, {path:paths.memberStatus(taskId,'A'),content:encodeJson({state:'running',deliveryId:''})},
  ],'original member'))
  const record={identity:{workId:'worker',executionId:'e',role:'Worker',taskId,member:'A',workerId:'child'},sessionId:'s',generation:1}
  runtime.roleRecords.set('worker',record)
  runtime.native={stop:async()=>{
    await withSnapshot(files,snapshot=>files.commit(snapshot,[{path:paths.memberStatus(taskId,'A'),content:encodeJson({state:'complete',deliveryId:''})}],'member won'))
    return{status:'stopped'}
  }}
  await storage.set(runtime.prefix+'restores/command',{commandId:'one',createdAt:'2026-10-31T00:00:00Z',input:{target:record.identity,facts:'interrupted',hypotheses:'unknown',actionsTaken:'saved',continuation:'continue'},complete:false})
  await runtime.processRestores()
  await Promise.all([...runtime.stopOperations.values()].map((stop:any)=>stop.promise))
  await runtime.processRestores()
  assert.equal((await storage.get<any>(runtime.prefix+'restores/command')).complete,true)
  await withSnapshot(files,async snapshot=>assert.equal(await files.read(snapshot,paths.state('A',taskId)+'/recovery'),undefined))
})

test('assistant message captures actual native model source once, never configured candidates or invented version',async t=>{
  const {runtime}=await runtimeFixture(t)
  let actualModel='actual-model-202610'
  runtime.native={get:()=>({actualAgent:{session:{requestContext:()=>({provider:'native-provider',model:actualModel})}}})}
  const binding={role:'Foreground',workId:'front',executionId:'e',owner:'A'}
  await runtime.services().conversation.send({id:'answer',text:'result',intent:'human'},binding,'native-call-1')
  actualModel='different-current-model'
  await runtime.services().conversation.send({id:'answer',text:'result',intent:'human'},binding,'native-call-1')
  const message=await runtime.conversation.read('answer')
  assert.equal(message.model,'actual-model-202610');assert.equal(message.modelVersion,undefined)
})

test('notification discovery at newer unrelated heads keeps one pending responsibility per work/task',async()=>{
  const {runtime,rows}=queue()
  const request={role:'Worker',taskId:'T',workerId:'child',reason:'notification',sources:[{path:'state/A/T/Worker_child_Planner',version:'empty-sha'}]}
  await runtime.wake({...request,id:'head-1'})
  await runtime.wake({...request,id:'head-2'})
  assert.equal([...rows.values()].filter(row=>row.request).length,1)
  await runtime.wake({role:'Organizer',taskId:'T1',reason:'notification',sources:[],id:'O1'})
  await runtime.wake({role:'Organizer',taskId:'T2',reason:'notification',sources:[],id:'O2'})
  assert.equal([...rows.values()].filter(row=>row.request).length,3,'singleton Organizer still retains separate Task responsibilities')
})

test('a queued notification already consumed before execution cannot produce a stale native send',async t=>{
  const {runtime,files,rows}=await runtimeFixture(t)
  const source='state/Worker_A_Direct_old'
  await withSnapshot(files,snapshot=>files.commit(snapshot,[{path:source,content:''}],'notify'))
  await runtime.wake({id:'queued',role:'Worker',workerId:'old',reason:'notification',sources:[{path:source,version:'empty'}]})
  await withSnapshot(files,snapshot=>files.commit(snapshot,[{path:source,content:null}],'actual recipient claimed'))
  runtime.native={open:()=>{throw new Error('stale notification reached native.open')}}
  await runtime.runQueue()
  assert.equal([...rows.values()].find(row=>row.request?.id==='queued').delivered,true)
})

test('invited Host restoration stays within its member domain and cannot reset principal or third-party managers',async t=>{
  const {runtime,files,storage}=await runtimeFixture(t),taskId='33333333-3333-4333-8333-333333333333'
  runtime.config.member='B';runtime.config.primary=false
  await withSnapshot(files,snapshot=>files.commit(snapshot,[
    {path:paths.task(taskId),content:encodeJson({version:1,taskId,route:'O',owner:'A',sourcePath:'tasks/work_O.md',status:'running',members:['A','B','C']})},
    ...['A','B','C'].flatMap(member=>[{path:paths.inbox(taskId,member),content:'work'}, {path:paths.memberStatus(taskId,member),content:encodeJson({state:'running',deliveryId:''})}]),
  ],'participants'))
  await storage.set(runtime.prefix+'host-restores/member',{commandId:'member-reset',createdAt:'2026-10-31T00:00:00Z',input:{facts:'B error',hypotheses:'unknown',actionsTaken:'saved',continuation:'B resume'},complete:false})
  await runtime.processHostRestores()
  await withSnapshot(files,async snapshot=>{
    assert.equal(await files.read(snapshot,paths.state('B',taskId)+'/recovery'),'')
    for(const member of ['A','C'])assert.deepEqual(await files.listDirectory(snapshot,paths.state(member,taskId)),[])
    const input=JSON.parse((await files.read(snapshot,runtime.recoveryInputPath(taskId,'B','Planner')))!)
    assert.equal(input.facts,'B error');assert.equal(input.debugPath,'debug/2026-10-31.md')
  })
})

for (const failure of ['missing', 'malformed', 'unreadable'] as const) {
  test(`Helper recovery notification still reaches native send with known facts when diagnostic input is ${failure}`, async t => {
    const { runtime, files, rows } = await runtimeFixture(t)
    const taskId = '44444444-4444-4444-8444-444444444444'
    const source = paths.state('A', taskId) + '/Planner_Helper'
    const diagnosticPath = runtime.recoveryInputPath(taskId, 'A', 'Planner')
    await withSnapshot(files, snapshot => files.commit(snapshot, [
      { path: source, content: '' },
      { path: paths.task(taskId), content: encodeJson({ version: 1, taskId, route: 'O', owner: 'A', sourcePath: 'tasks/work_O.md', status: 'running' }) },
      { path: paths.memberStatus(taskId, 'A'), content: encodeJson({ state: 'running', deliveryId: '' }) },
      ...(failure === 'malformed' ? [{ path: diagnosticPath, content: '{broken diagnostic JSON' }] : []),
    ], 'actual Helper notification'))
    if (failure === 'unreadable') {
      const originalRead = files.read.bind(files)
      files.read = async (snapshot, path) => {
        if (path === diagnosticPath) throw new Error('diagnostic capability temporarily unavailable')
        return originalRead(snapshot, path)
      }
    }
    const sent: Array<{ body: any; id: string; mode: string; source: string }> = []
    let opens = 0
    runtime.gateway = { exists: async () => false }
    runtime.native = { get: () => undefined, open: async () => {
      opens++
      return { send: async (text: string, id: string, mode: string, source: string) => { sent.push({ body: JSON.parse(text), id, mode, source }) } }
    } }
    const sources = [{ path: source, version: 'actual-notification-version' }]
    await runtime.wake({ id: 'diagnostic-' + failure, role: 'Planner', taskId, reason: 'notification', sources })
    await runtime.runQueue()
    assert.equal(opens, 1)
    assert.equal(sent.length, 1)
    assert.equal(sent[0]!.body.taskId, taskId)
    assert.deepEqual(sent[0]!.body.sources, sources)
    assert.equal(sent[0]!.body.recoveryInput.path, diagnosticPath)
    assert.equal(typeof sent[0]!.body.recoveryInput.unavailable, 'string')
    assert.ok(sent[0]!.body.recoveryInput.unavailable.length > 0)
    if (failure === 'missing') assert.match(sent[0]!.body.recoveryInput.unavailable, /absent/)
    if (failure === 'unreadable') assert.match(sent[0]!.body.recoveryInput.unavailable, /capability temporarily unavailable/)
    assert.equal(sent[0]!.mode, 'followup')
    assert.equal(sent[0]!.source, 'deepseek-servant')
    assert.match(sent[0]!.id, /^dss-wake-/)
    assert.equal([...rows.values()].find(row => row.request?.id === 'diagnostic-' + failure).delivered, true)
    await runtime.runQueue()
    assert.equal(sent.length, 1, 'fallback does not redeliver a completed wake')
    await withSnapshot(files, async snapshot => assert.equal(await files.readBytes(snapshot, source) !== undefined, true, 'runtime does not consume the recipient signal'))
  })
}

for (const eligibility of ['consumed', 'task-complete', 'member-complete', 'active', 'seats-full', 'stop-unconfirmed'] as const) {
  test(`missing diagnostic fallback does not bypass ${eligibility} wake eligibility`, async t => {
    const { runtime, files, rows } = await runtimeFixture(t)
    const taskId = '55555555-5555-4555-8555-555555555555'
    const role = eligibility === 'seats-full' ? 'Worker' : 'Planner'
    const source = paths.state('A', taskId) + '/' + role + '_Helper'
    await withSnapshot(files, snapshot => files.commit(snapshot, [
      ...(eligibility === 'consumed' ? [] : [{ path: source, content: '' }]),
      { path: paths.task(taskId), content: encodeJson({ version: 1, taskId, route: 'O', owner: 'A', sourcePath: 'tasks/work_O.md', status: eligibility === 'task-complete' ? 'complete' : 'running' }) },
      { path: paths.memberStatus(taskId, 'A'), content: encodeJson({ state: eligibility === 'member-complete' ? 'complete' : 'running', deliveryId: '' }) },
    ], 'existing eligibility facts'))
    const request = { id: 'eligibility-' + eligibility, role, taskId, reason: 'notification', sources: [{ path: source, version: 'v1' }] }
    if (eligibility === 'seats-full') runtime.config.workerSeats = 0
    if (eligibility === 'active' || eligibility === 'stop-unconfirmed') {
      const workId = runtime.requestKey(request)
      runtime.roleRecords.set(workId, { identity: { workId, executionId: 'existing', role, taskId, member: 'A' }, sessionId: 'native-existing', generation: 1,
        ...(eligibility === 'stop-unconfirmed' ? { stopUnknown: { reason: 'producer unsettled', jobs: ['job-1'] } } : {}) })
    }
    let opens = 0
    runtime.gateway = { exists: async () => false }
    runtime.native = { get: () => eligibility === 'active' ? { observe: () => ({ state: 'running' }) } : undefined,
      open: async () => { opens++; throw new Error('ineligible wake reached native execution') } }
    await runtime.wake(request)
    await runtime.runQueue()
    await runtime.errorTail
    assert.equal(opens, 0)
    const wake = [...rows.values()].find(row => row.request?.id === request.id)
    assert.equal(Boolean(wake.delivered), ['consumed', 'task-complete', 'member-complete'].includes(eligibility))
  })
}

function coldStopRecord(workId = 'cold-work') {
  return { identity: { workId, executionId: 'old-execution', role: 'Worker', taskId: 'T', member: 'A', workerId: 'child' },
    sessionId: 'cold-session', generation: 1,
    stopIntent: { workId, executionId: 'old-execution', agentId: 'cold-session', sessionId: 'cold-session', jobs: ['owned-job'], phase: 'stopping' },
    stopUnknown: { status: 'unconfirmed', reason: 'producer still unknown', jobs: ['owned-job'] },
    lastWake: { id: 'original-wake', role: 'Worker', taskId: 'T', workerId: 'child', reason: 'notification', sources: [{ path: 'state/A/T/Worker_child_Planner', version: 'original' }] } }
}
function coldHistory(runtime: any) {
  const state = { events: [] as any[], error: false, reads: 0, closes: 0, jobs: [] as any[] }
  const persistence = { stat: async () => ({ sizeBytes: 123 }), open: async (_id: string, mode: string) => {
    assert.equal(mode, 'read')
    return { read: async () => { state.reads++; if (state.error) throw new Error('cold log unavailable'); return { events: state.events } },
      close: async () => { state.closes++ } }
  } }
  runtime.ctx = { agents: { get: () => undefined }, sessions: { get: () => undefined }, jobs: { list: () => state.jobs },
    get: (name: string) => name === 'sessionPersistence' ? persistence : undefined }
  runtime.native = { stop: async () => ({ status: 'superseded' }), get: () => undefined }
  return state
}

test('cold runtime rebuild preserves stop intent and only late exact-owner durable settlement resolves unknown', async t => {
  const { runtime, rows } = await runtimeFixture(t), record = coldStopRecord()
  await runtime.saveRole(record)
  runtime.roleRecords.clear()
  for (const row of rows.values()) if (row.identity) runtime.roleRecords.set(row.identity.workId, structuredClone(row))
  const history = coldHistory(runtime)
  assert.equal((await runtime.stopOwnedRecord(record)).status, 'unconfirmed', 'empty registry and history are not evidence')
  history.events.push({ type: 'job/settled', data: { owner: 'another-owner', jobId: 'owned-job', producerReported: true } })
  assert.equal((await runtime.stopOwnedRecord(record)).status, 'unconfirmed')
  history.events.push({ type: 'job/settled', data: { owner: 'cold-session', jobId: 'owned-job', producerReported: false } })
  assert.equal((await runtime.stopOwnedRecord(record)).status, 'unconfirmed')
  history.events.push({ type: 'job/settled', data: { owner: 'cold-session', jobId: 'owned-job', producerReported: true } })
  assert.equal((await runtime.stopOwnedRecord(record)).status, 'stopped')
  assert.equal(runtime.roleRecords.get(record.identity.workId).stopped, true)
  assert.equal(runtime.roleRecords.get(record.identity.workId).stopUnknown, undefined)
  assert.equal(history.reads, history.closes, 'cold read handles always close')
})

test('stop-intent-only crash window and unavailable cold history cannot be promoted to stopped', async t => {
  const { runtime } = await runtimeFixture(t)
  const record: any = coldStopRecord()
  delete record.stopUnknown // crash after durable intent but before stop result save
  await runtime.saveRole(record)
  const history = coldHistory(runtime)
  history.error = true
  const unavailable = await runtime.stopOwnedRecord(record)
  assert.equal(unavailable.status, 'unconfirmed'); assert.match(unavailable.reason, /history is unavailable/)
  assert.equal(history.closes, 1)
  history.error = false
  assert.equal((await runtime.stopOwnedRecord(record)).status, 'unconfirmed')
  const noProducer: any = coldStopRecord('no-producer')
  delete noProducer.stopUnknown
  noProducer.stopIntent.jobs = []
  await runtime.saveRole(noProducer)
  assert.equal((await runtime.stopOwnedRecord(noProducer)).status, 'unconfirmed', 'intent without a producer identity is not quiescence')
})

test('native evidence hook survives an older role save and is present before stopUnknown exists', async t => {
  const { runtime, rows } = await runtimeFixture(t)
  const record: any = coldStopRecord()
  delete record.stopUnknown; delete record.stopIntent
  await runtime.saveRole(record)
  const evidence = { workId: record.identity.workId, executionId: record.identity.executionId,
    agentId: record.sessionId, sessionId: record.sessionId, jobs: ['new-job'], phase: 'stopping' }
  await runtime.native.evidence.save(evidence)
  await runtime.saveRole({ ...record, lastWake: { ...record.lastWake, id: 'later-context' } })
  assert.deepEqual(runtime.roleRecords.get(record.identity.workId).stopIntent, evidence)
  const persisted: any = [...rows.values()].find(row => row.identity?.workId === record.identity.workId)
  assert.deepEqual(persisted.stopIntent, evidence)
  assert.equal(persisted.stopUnknown, undefined)
})

test('host restoration remains incomplete while stop evidence is unresolved and only later confirmation clears mechanical error', async t => {
  const { runtime, storage, files, rows } = await runtimeFixture(t), record = coldStopRecord()
  await runtime.saveRole(record)
  const history = coldHistory(runtime)
  let restored = 0
  runtime.environment.restored = () => { restored++ }
  const key = runtime.prefix + 'host-restores/cold'
  await storage.set(key, { commandId: 'cold-recovery', createdAt: '2026-10-31T00:00:00Z',
    input: { facts: 'failed stop', hypotheses: 'unknown', actionsTaken: 'saved', continuation: 'inspect' }, complete: false })
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: 'state/A/T/recovery', content: '' }], 'existing recovery'))
  await runtime.processHostRestores()
  const first = await storage.get<any>(key)
  assert.equal(first.complete, false); assert.equal(first.unresolved[0].sessionId, record.sessionId)
  assert.equal(restored, 0)
  assert.ok([...rows.values()].some(row => row.request?.role === 'Helper' && row.request.context?.hostRestoration === 'unconfirmed'))
  await withSnapshot(files, async snapshot => assert.equal(await files.read(snapshot, 'state/A/T/recovery'), ''))
  history.events.push({ type: 'job/settled', data: { owner: 'cold-session', jobId: 'owned-job', producerReported: true } })
  await runtime.processHostRestores()
  await Promise.all([...runtime.stopOperations.values()].map((stop:any)=>stop.promise))
  await runtime.processHostRestores()
  assert.equal((await storage.get<any>(key)).complete, true)
  assert.equal(restored, 1)
  const resumed: any = [...rows.values()].find(row => row.request?.id === 'host-restored:cold-recovery:old-execution')
  assert.deepEqual(resumed.request.sources, record.lastWake.sources)
  assert.equal(resumed.request.reason, 'startup-recovery')
  assert.equal(resumed.request.taskId, record.lastWake.taskId)
  assert.equal(resumed.recovery.targetExecutionId, record.identity.executionId)
  assert.equal(resumed.delivered, undefined, 'normal current eligibility queue still owns admission')
})

test('a live running producer remains a blocker despite contradictory durable settled history', async t => {
  const { runtime } = await runtimeFixture(t), record = coldStopRecord()
  await runtime.saveRole(record)
  const history = coldHistory(runtime)
  history.jobs = [{ id: 'owned-job', owner: record.sessionId, status: 'running' }]
  history.events = [{ type: 'job/settled', data: { owner: record.sessionId, jobId: 'owned-job', producerReported: true } }]
  assert.equal((await runtime.stopOwnedRecord(record)).status, 'unconfirmed')
})

for (const firstWriter of ['ordinary', 'evidence'] as const) {
  test(`role persistence serializes ${firstWriter}-first in-flight write without losing stop evidence`, async t => {
    const { runtime, storage, rows } = await runtimeFixture(t)
    const record: any = coldStopRecord()
    delete record.stopIntent; delete record.stopUnknown
    await runtime.saveRole(record)
    const evidence = { workId: record.identity.workId, executionId: record.identity.executionId,
      agentId: record.sessionId, sessionId: record.sessionId, jobs: ['racing-job'], phase: 'stopping' }
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const originalSet = storage.set.bind(storage)
    let writes = 0
    storage.set = async (key: string, value: unknown) => {
      if (key.startsWith(runtime.prefix + 'roles/')) {
        writes++
        if (writes === 1) { entered.resolve(); await release.promise }
      }
      await originalSet(key, value)
    }
    const ordinary = () => runtime.saveRole({ ...record, lastWake: { ...record.lastWake, id: 'racing-context' } })
    const evidenceWrite = () => runtime.native.evidence.save(evidence)
    const first = firstWriter === 'ordinary' ? ordinary() : evidenceWrite()
    await entered.promise
    const second = firstWriter === 'ordinary' ? evidenceWrite() : ordinary()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(writes, 1, 'second write must not enter storage ahead of the first pending write')
    release.resolve()
    await Promise.all([first, second])
    const persisted: any = [...rows.values()].find(row => row.identity?.workId === record.identity.workId)
    assert.deepEqual(persisted.stopIntent, evidence)
    assert.equal(persisted.lastWake.id, 'original-wake', 'an ordinary save cannot relabel the last confirmed native input')
    assert.deepEqual(runtime.roleRecords.get(record.identity.workId).stopIntent, evidence)
  })
}

test('late ordinary save from an older execution cannot overwrite its replacement generation', async t => {
  const { runtime, rows } = await runtimeFixture(t), old: any = coldStopRecord()
  await runtime.saveRole(old)
  const replacement = { ...old, identity: { ...old.identity, executionId: 'new-execution' }, generation: 2, stopIntent: undefined, stopUnknown: undefined }
  await runtime.saveRole(replacement)
  await assert.rejects(runtime.saveRole({ ...old, stopped: true }), /superseded execution/)
  await assert.rejects(runtime.saveRole({ ...replacement, identity: { ...replacement.identity, executionId: 'same-generation-impostor' } }), /superseded execution/)
  assert.equal(runtime.roleRecords.get(old.identity.workId).identity.executionId, 'new-execution')
  const persisted: any = [...rows.values()].find(row => row.identity?.workId === old.identity.workId)
  assert.equal(persisted.identity.executionId, 'new-execution')
})


test('durable local task pause blocks only business-role wake queues across controls reconstruction', async t => {
  const { runtime, files, storage, rows } = await runtimeFixture(t), held = 'held-task', other = 'other-task'
  await withSnapshot(files, snapshot => files.commit(snapshot, [held, other].flatMap(taskId => [
    { path: paths.task(taskId), content: encodeJson({ version: 1, taskId, route: 'O', owner: 'A', status: 'running', sourcePath: 'tasks/' + taskId + '_O.md' }) },
    { path: paths.memberStatus(taskId, 'A'), content: encodeJson({ state: 'running', deliveryId: '' }) },
  ]), 'two active task identities'))
  await runtime.controls.setTask('pause-held', held, 'paused')
  runtime.controls = new ExecutionControls(storage, 'local')
  const opened: any[] = []
  runtime.gateway = { exists: async () => false }
  runtime.native = { get: () => undefined, open: async (identity: any) => { opened.push(identity); return { send: async () => {} } } }
  for (const role of ['Planner', 'Worker', 'Organizer', 'Foreground', 'Recorder']) await runtime.wake({ id: 'held-' + role, role, taskId: held, reason: 'business-complete', sources: [] })
  await runtime.wake({ id: 'other-planner', role: 'Planner', taskId: other, reason: 'user-resume', sources: [] })
  await runtime.runQueue(); await runtime.loop.poll(); await runtime.loop.poll()
  assert.deepEqual(opened.map(item => item.role).sort(), ['Foreground', 'Planner', 'Recorder'])
  assert.equal(opened.find(item => item.role === 'Planner').taskId, other)
  for (const role of ['Planner', 'Worker', 'Organizer']) assert.equal(Boolean([...rows.values()].find(row => row.request?.id === 'held-' + role).delivered), false)
})
test('task pause stops only exact owned business executions and preserves unconfirmed diagnostics', async t => {
  const { runtime } = await runtimeFixture(t), stops: string[][] = []
  for (const [role, taskId] of [['Worker', 'held'], ['Planner', 'held'], ['Organizer', 'held'], ['Foreground', 'held'], ['Recorder', 'held'], ['Worker', 'other']]) {
    const workId = role + ':' + taskId
    await runtime.saveRole({ identity: { role, taskId: role === 'Organizer' ? undefined : taskId, workId, executionId: workId + ':execution' },
      sessionId: workId, generation: 1, lastWake: { taskId } })
  }
  runtime.native = { stop: async (workId: string, executionId: string) => { stops.push([workId, executionId]); return workId.startsWith('Worker:held')
    ? { status: 'unconfirmed', reason: 'owned job is still stopping', jobs: ['job-1'] } : { status: 'stopped' } } }
  runtime.error = () => {}
  await runtime.controls.setTask('pause', 'held', 'paused')
  await runtime.applyUserControls(); await runtime.applyUserControls()
  assert.deepEqual(stops.map(([id]) => id).sort(), ['Organizer:held', 'Planner:held', 'Worker:held'])
  assert.ok(stops.every(([workId, executionId]) => executionId === workId + ':execution'))
  assert.equal(runtime.roleRecords.get('Worker:held').stopped, undefined)
  assert.deepEqual(runtime.roleRecords.get('Worker:held').stopUnknown.jobs, ['job-1'])
  assert.equal(runtime.roleRecords.get('Planner:held').stopped, true)
  assert.equal(runtime.roleRecords.get('Worker:other').stopped, undefined)
})
test('resume scans only the requested Task: nonempty Worker notes continue, all-empty notes return to its Planner', async t => {
  const { runtime, files, rows } = await runtimeFixture(t)
  const ids = ['notes-task', 'empty-task', 'unrelated-task']
  await withSnapshot(files, snapshot => files.commit(snapshot, ids.flatMap(taskId => [
    { path: paths.task(taskId), content: encodeJson({ version: 1, taskId, route: 'O', owner: 'A', status: 'running', sourcePath: 'tasks/' + taskId + '_O.md' }) },
    { path: paths.inbox(taskId, 'A'), content: 'existing assignment' },
    { path: paths.memberStatus(taskId, 'A'), content: encodeJson({ state: 'running', deliveryId: '' }) },
    { path: paths.member(taskId, 'A') + '/workers/child/notes.md', content: taskId === 'empty-task' ? '' : 'continue preserved work' },
  ]), 'preserved recovery records'))
  runtime.pump = async () => {}
  await runtime.resumeTask('notes-task', 'resume-notes')
  let wakes = [...rows.values()].filter(row => row.request).map(row => row.request)
  assert.deepEqual(wakes.map(wake => [wake.role, wake.taskId, wake.workerId]), [['Worker', 'notes-task', 'child']])
  await runtime.resumeTask('empty-task', 'resume-empty')
  wakes = [...rows.values()].filter(row => row.request).map(row => row.request)
  assert.ok(wakes.some(wake => wake.role === 'Planner' && wake.taskId === 'empty-task'))
  assert.ok(!wakes.some(wake => wake.taskId === 'unrelated-task'))
})
test('single execution stop does not establish a task-wide hold and cleanup releases control associations', async t => {
  const { runtime } = await runtimeFixture(t), record = { identity: { workId: 'one-worker', executionId: 'one-execution', role: 'Worker', taskId: 'T', member: 'A' }, sessionId: 'session', generation: 1 }
  await runtime.saveRole(record)
  runtime.native = { stop: async (workId: string, executionId: string) => { assert.equal(workId, 'one-worker'); assert.equal(executionId, 'one-execution'); return { status: 'stopped' } } }
  await runtime.requestExecutionStop('stop-one', 'one-worker', 'one-execution')
  assert.equal(await runtime.controls.taskHeld('T'), false)
  assert.equal((await runtime.controls.execution('one-execution')).result.state, 'stopped')
  await runtime.controls.setTask('pause-before-clean', 'T', 'paused')
  await runtime.releaseTask({ taskId: 'T', owner: 'A', members: ['A'], status: 'complete' })
  assert.equal(await runtime.controls.task('T'), undefined)
  assert.equal(await runtime.controls.execution('one-execution'), undefined)
})

for (const admitted of [true, false]) test(`Organizer uncertain B delivery uses native admission=${admitted}, never guesses from A lastWake`, async t => {
  const { runtime } = await runtimeFixture(t), messages = new Set<string>(), stops: string[] = []
  let failB = false
  runtime.error = () => {}
  runtime.gateway = { exists: async () => false }
  runtime.native = {
    get: () => ({ observe: () => ({ state: 'idle' }), hasMessage: (id: string) => messages.has(id) }),
    open: async () => ({ send: async (_body: string, id: string) => {
      if (failB) { if (admitted) messages.add(id); throw new Error(admitted ? 'flush failed after native admission' : 'native admission failed') }
      messages.add(id)
    } }),
    stop: async (workId: string) => { stops.push(workId); return { status: 'stopped' } },
  }
  await runtime.wake({ id: 'A-finished', role: 'Organizer', taskId: 'A', reason: 'user-resume', sources: [] })
  await runtime.runQueue()
  const key = runtime.roleKey('Organizer')
  assert.equal(runtime.roleRecords.get(key).lastWake.taskId, 'A')
  failB = true
  await runtime.wake({ id: 'B-next', role: 'Organizer', taskId: 'B', reason: 'user-resume', sources: [] })
  await runtime.runQueue()
  const pending = runtime.roleRecords.get(key)
  assert.equal(pending.delivery.confirmed, false)
  assert.equal(pending.delivery.request.taskId, 'B')
  assert.equal(pending.lastWake.taskId, 'A')
  assert.equal(await runtime.currentTask(pending), admitted ? 'B' : 'A')
  await runtime.controls.setTask('pause-not-current', admitted ? 'A' : 'B', 'paused')
  await runtime.applyUserControls()
  assert.deepEqual(stops, [])
})
test('Organizer pending delivery must persist before native send can admit its next Task', async t => {
  const { runtime, storage } = await runtimeFixture(t)
  const send: string[] = [], errors: unknown[] = []
  runtime.error = (error: unknown) => errors.push(error)
  runtime.gateway = { exists: async () => false }
  runtime.native = { get: () => undefined, open: async () => ({ send: async (_body: string, id: string) => { send.push(id) } }) }
  const original = storage.set.bind(storage)
  storage.set = async (key: string, value: any) => {
    if (key.startsWith(runtime.prefix + 'roles/') && value.delivery?.confirmed === false) throw new Error('pending delivery storage unavailable')
    await original(key, value)
  }
  await runtime.wake({ id: 'blocked-delivery', role: 'Organizer', taskId: 'B', reason: 'user-resume', sources: [] })
  await runtime.runQueue()
  assert.deepEqual(send, [])
  assert.match(String(errors[0]), /pending delivery storage unavailable/)
})
test('late ordinary role save cannot erase newer stop evidence or confirmed stopped state', async t => {
  const { runtime, rows } = await runtimeFixture(t), record: any = coldStopRecord()
  delete record.stopIntent; delete record.stopUnknown
  await runtime.saveRole(record)
  const evidence = { workId: record.identity.workId, executionId: record.identity.executionId, agentId: record.sessionId, sessionId: record.sessionId, jobs: ['exact-producer'], phase: 'stopping' }
  await runtime.native.evidence.save(evidence)
  await runtime.saveRole({ ...runtime.roleRecords.get(record.identity.workId), stopped: true })
  await runtime.saveRole({ ...record, lastWake: { ...record.lastWake, id: 'late-old-save' } })
  const saved = runtime.roleRecords.get(record.identity.workId)
  assert.equal(saved.stopped, true)
  assert.deepEqual(saved.stopIntent, evidence)
  const persisted = [...rows.values()].find(row => row.identity?.workId === record.identity.workId)
  assert.equal(persisted.stopped, true)
  assert.deepEqual(persisted.stopIntent, evidence)
})
test('unreadable Organizer admission reports diagnostics without blocking another Task or exact execution stop', async t => {
  const { runtime } = await runtimeFixture(t), errors: unknown[] = [], stops: string[] = []
  runtime.error = (error: unknown) => errors.push(error)
  const organizer = { identity: { workId: 'organizer', executionId: 'organizer-execution', role: 'Organizer' }, sessionId: 'organizer-session', generation: 1,
    lastWake: { taskId: 'A' }, delivery: { request: { taskId: 'B' }, messageId: 'unknown-message', confirmed: false } }
  await runtime.saveRole(organizer)
  await runtime.saveRole({ identity: { workId: 'other-worker', executionId: 'other-execution', role: 'Worker', taskId: 'other' }, sessionId: 'other-session', generation: 1 })
  runtime.native = { get: () => ({ hasMessage: () => { throw new Error('native inbox unavailable') } }),
    stop: async (workId: string) => { stops.push(workId); return { status: 'stopped' } } }
  await runtime.controls.setTask('pause-A', 'A', 'paused')
  await runtime.controls.setTask('pause-other', 'other', 'paused')
  await runtime.applyUserControls()
  assert.deepEqual(stops, ['other-worker'])
  assert.match(String(errors[0]), /native inbox unavailable/)
  assert.equal(runtime.roleRecords.get('organizer').stopped, undefined)
  await runtime.requestExecutionStop('exact-stop-organizer', 'organizer', 'organizer-execution')
  assert.deepEqual(stops, ['other-worker', 'organizer'])
})

test('late nonempty A delivery save cannot overwrite B pending/confirmed delivery or lastWake', async t => {
  const { runtime, rows } = await runtimeFixture(t)
  const base = { identity: { workId: 'organizer-monotonic', executionId: 'one-execution', role: 'Organizer' }, sessionId: 'session-monotonic', generation: 1 }
  const a = { ...base, delivery: { request: { id: 'request-A', role: 'Organizer', taskId: 'A' }, messageId: 'message-A', confirmed: false } }
  await runtime.saveRole(base)
  await runtime.saveRole(a, false, 'prepare')
  await runtime.saveRole(a, false, 'confirm')
  const oldA = structuredClone(runtime.roleRecords.get(base.identity.workId))
  const b = { ...oldA, delivery: { request: { id: 'request-B', role: 'Organizer', taskId: 'B' }, messageId: 'message-B', confirmed: false } }
  await runtime.saveRole(b, false, 'prepare')
  await runtime.saveRole(oldA)
  assert.equal(runtime.roleRecords.get(base.identity.workId).delivery.messageId, 'message-B')
  assert.equal(runtime.roleRecords.get(base.identity.workId).delivery.sequence, 2)
  assert.equal(runtime.roleRecords.get(base.identity.workId).delivery.confirmed, false)
  await runtime.saveRole(b, false, 'confirm')
  await runtime.saveRole(oldA)
  const result = runtime.roleRecords.get(base.identity.workId)
  assert.equal(result.delivery.messageId, 'message-B')
  assert.equal(result.delivery.confirmed, true)
  assert.equal(result.lastWake.taskId, 'B')
  const persisted = [...rows.values()].find(row => row.identity?.workId === base.identity.workId)
  assert.equal(persisted.delivery.messageId, 'message-B'); assert.equal(persisted.lastWake.taskId, 'B')
  await runtime.saveRole(b, false, 'prepare')
  assert.equal(runtime.roleRecords.get(base.identity.workId).delivery.confirmed, true, 'same-message prepare replay cannot regress acknowledgement')
  assert.equal(runtime.roleRecords.get(base.identity.workId).delivery.sequence, 2)
})
test('late A confirmation is rejected after B admission was durably prepared', async t => {
  const { runtime } = await runtimeFixture(t)
  const base = { identity: { workId: 'organizer-confirm', executionId: 'one-execution', role: 'Organizer' }, sessionId: 'session-confirm', generation: 1 }
  const a = { ...base, delivery: { request: { taskId: 'A' }, messageId: 'message-A', confirmed: false } }
  const b = { ...base, delivery: { request: { taskId: 'B' }, messageId: 'message-B', confirmed: false } }
  await runtime.saveRole(base)
  await runtime.saveRole(a, false, 'prepare')
  await runtime.saveRole(b, false, 'prepare')
  await assert.rejects(runtime.saveRole(a, false, 'confirm'), /superseded delivery/)
  assert.equal(runtime.roleRecords.get(base.identity.workId).delivery.messageId, 'message-B')
  assert.equal(runtime.roleRecords.get(base.identity.workId).delivery.confirmed, false)
  await runtime.saveRole(b, false, 'confirm')
  assert.equal(runtime.roleRecords.get(base.identity.workId).lastWake.taskId, 'B')
})

async function recoveryTasks(files: LocalFiles, badStatus?: string) {
  await withSnapshot(files, snapshot => files.commit(snapshot, ['broken-T', 'valid-T'].flatMap(taskId => [
    { path: paths.task(taskId), content: encodeJson({ version: 1, taskId, route: 'P', owner: 'A', sourcePath: 'tasks/' + taskId + '_P.md', status: 'running', members: ['A'] }) },
    { path: paths.inbox(taskId, 'A'), content: 'Original recoverable work ' + taskId },
    { path: paths.memberStatus(taskId, 'A'), content: taskId === 'broken-T' && badStatus !== undefined ? badStatus : encodeJson({ state: 'running', deliveryId: 'original' }) },
  ]), 'Original recoverable Tasks'))
}
test('actual runtime startup recovery isolates damaged metadata, invalidates old valid Task and durably reports Helper error', async t => {
  const { runtime, files, rows, errors } = await runtimeFixture(t)
  await recoveryTasks(files)
  assert.equal((await withSnapshot(files, snapshot => runtime.scanMembers(snapshot))).length, 2)
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: paths.task('broken-T'), content: '{bad metadata' }], 'Metadata becomes damaged'))
  runtime.pump = async () => {} // Observe actual durable wake arrangement, not a native model execution.
  await runtime.startup(); await runtime.errorTail
  const wakes = [...rows.values()].filter(row => row.request).map(row => row.request)
  assert.ok(wakes.some(wake => wake.taskId === 'valid-T' && wake.role === 'Planner'))
  assert.ok(!wakes.some(wake => wake.taskId === 'broken-T'))
  assert.ok(wakes.some(wake => wake.role === 'Helper' && wake.reason === 'helper'))
  assert.ok(errors.some(error => error instanceof Error && error.message.includes(paths.task('broken-T'))))
})
test('actual runtime startup isolates malformed member status from another Task recovery', async t => {
  const { runtime, files, rows, errors } = await runtimeFixture(t)
  await recoveryTasks(files, '{bad status')
  runtime.pump = async () => {}
  await runtime.startup(); await runtime.errorTail
  const wakes = [...rows.values()].filter(row => row.request).map(row => row.request)
  assert.ok(wakes.some(wake => wake.taskId === 'valid-T' && wake.role === 'Planner'))
  assert.ok(!wakes.some(wake => wake.taskId === 'broken-T'))
  assert.ok(errors.some(error => error instanceof Error && error.cause instanceof SyntaxError && error.message.includes(paths.memberStatus('broken-T', 'A'))))
})
test('actual runtime must not reinterpret an existing invalid member state as running', async t => {
  const { runtime, files, errors } = await runtimeFixture(t)
  await recoveryTasks(files, encodeJson({ state: 'not-a-member-state', deliveryId: 'original' }))
  const members = await withSnapshot(files, snapshot => runtime.scanMembers(snapshot))
  await runtime.errorTail
  assert.deepEqual(members.map((member: any) => member.taskId), ['valid-T'])
  assert.ok(errors.length > 0)
})
test('actual runtime recovery leaves global storage failure visible and can recover on the next snapshot', async t => {
  const { runtime, files } = await runtimeFixture(t)
  await recoveryTasks(files)
  const snapshot = files.snapshot.bind(files)
  files.snapshot = async () => { throw new Error('Recovery snapshot unavailable') }
  await assert.rejects(runtime.startup(), /Recovery snapshot unavailable/)
  files.snapshot = snapshot
  const list = files.listDirectory.bind(files)
  files.listDirectory = async (view, prefix) => { if (prefix === 'tasks/') throw new Error('Recovery directory unavailable'); return list(view, prefix) }
  await assert.rejects(runtime.startup(), /Recovery directory unavailable/)
  files.listDirectory = list
  assert.equal((await withSnapshot(files, view => runtime.scanMembers(view))).length, 2)
})

test('actual runtime rejects member state arrays instead of coercing them to accepted strings', async t => {
  const { runtime, files, errors } = await runtimeFixture(t)
  await recoveryTasks(files, encodeJson({ state: ['running'], deliveryId: 'original' }))
  const members = await withSnapshot(files, snapshot => runtime.scanMembers(snapshot))
  await runtime.errorTail
  assert.deepEqual(members.map((member: any) => member.taskId), ['valid-T'])
  assert.ok(errors.some(error => error instanceof Error && error.message.includes(paths.memberStatus('broken-T', 'A'))))
})

import { DshSessionReader } from '../src/adapters/dsh/sessions.js'
/** Persisted event / native projection checkpoint fixture only. The production
 * DshSessionReader and runtime startup/durable wake code run unchanged; this does
 * not instantiate AgentLoop or claim model/native executor integration. Event
 * shapes follow installed dsh-session and dsh-agent SessionEventMap contracts. */
async function coldSingletonContinuation(t: test.TestContext, role: 'Foreground' | 'Helper', evidence: 'interrupted' | 'unresolved-tool' | 'queued' | 'idle' | 'disposed' | 'user-aborted', stopped = false, userStopped = false) {
  const fixture = await runtimeFixture(t), { runtime, files, storage, rows } = fixture
  const sessionId = 'persisted-' + role, message = { id: 'queued-original', role: 'user', content: [{ type: 'text', text: 'Original unhandled input' }], source: { kind: 'user' } }
  const events: any[] = [{ seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } }]
  if (evidence === 'unresolved-tool') events.push({ seq: events.length, time: 2, type: 'tool/call', data: { turn: 1, step: 0, callId: 'original-call', name: 'dss_read', arguments: '{"path":"archives/completed/records.md"}' } })
  events.push({ seq: events.length, time: 3, type: 'turn/end', data: { turn: 1, reason: evidence === 'disposed' || evidence === 'user-aborted' ? { kind: 'aborted', reason: { kind: evidence === 'disposed' ? 'disposed' : 'user' } } : { kind: evidence === 'interrupted' ? 'interrupted' : 'completed' } } })
  if (evidence === 'queued') events.push({ seq: events.length, time: 4, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [message] } })
  const checkpoint = { inbox: { val: { 'next-turn': evidence === 'queued' ? [message] : [], 'next-step': [] } },
    turnBoundary: { val: { openTurnStartSeq: null, lastStepStartSeq: null, lastStepBoundary: null, lastTurn: 1 } } }
  let reads = 0, closes = 0
  const persistence = { stat: async (id: string) => id === sessionId ? { sizeBytes: 123 } : undefined,
    open: async (id: string, mode: string) => {
      assert.equal(id, sessionId); assert.equal(mode, 'read')
      return { header: { version: 4, id, createdAt: 0 }, inheritedEventCount: 0,
        read: async () => { reads++; return { events: structuredClone(events) } }, close: async () => { closes++ } }
    } }
  const projections = { restore: (_saved: unknown, input: any[]) => { assert.deepEqual(input, events); return { checkpoint: structuredClone(checkpoint) } } }
  runtime.ctx = { agents: { get: () => undefined }, sessions: { get: () => undefined }, jobs: { list: () => [] },
    get: (name: string) => name === 'sessionPersistence' ? persistence : name === 'sessionProjections' ? projections : undefined }
  const request = { id: 'already-delivered-' + role, role, ...(role === 'Foreground' ? { taskId: 'completed-before-crash' } : {}),
    reason: role === 'Foreground' ? 'business-complete' : 'helper', sources: [], context: { original: 'Claimed work must finish' } }
  const record = { identity: { workId: runtime.roleKey(role), executionId: 'original-' + role, role }, sessionId, generation: 1,
    ...(stopped ? { stopped: true } : {}), lastWake: request, delivery: { request, messageId: 'native-original-message', confirmed: true, sequence: 1 } }
  await runtime.saveRole(record)
  await runtime.wake(request)
  const delivered = [...rows].find(([, value]) => value.request?.id === request.id)!
  await storage.set(delivered[0], { ...delivered[1], delivered: true })
  // Neither an unconsumed notification nor an active Task can rescue this case.
  await storage.set(runtime.loop.key, { initial: {}, completed: { 'completed-before-crash': { Foreground: true, Recorder: true } } })
  runtime.roleRecords.clear()
  for (const value of rows.values()) if (value.identity && !value.released) runtime.roleRecords.set(value.identity.workId, structuredClone(value))
  assert.deepEqual(await withSnapshot(files, snapshot => files.listDirectory(snapshot, 'tasks/')), [])
  const inspection = await new DshSessionReader(runtime.ctx).inspect(sessionId)
  assert.equal(inspection.lifecycleKnown, true)
  assert.equal(inspection.lastTurn?.reason, evidence === 'disposed' || evidence === 'user-aborted' ? 'aborted' : evidence === 'interrupted' ? 'interrupted' : 'completed')
  assert.equal(inspection.unresolvedToolCallIds.length, evidence === 'unresolved-tool' ? 1 : 0)
  assert.equal(inspection.queuedInbox.nextTurn.length, evidence === 'queued' ? 1 : 0)
  if (userStopped) await runtime.controls.requestExecutionStop('explicit-user-stop', { workId: record.identity.workId, executionId: record.identity.executionId })
  runtime.pump = async () => {} // Only durable scheduling, not native execution.
  await runtime.startup(); await runtime.errorTail
  assert.equal(reads, closes, 'all cold read leases close')
  return { ...fixture, record, requests: [...rows.values()].filter(row => row.request && !row.delivered).map(row => row.request) }
}
for (const role of ['Foreground', 'Helper'] as const) {
  for (const evidence of ['interrupted', 'unresolved-tool', 'queued'] as const) test('cold ' + role + ' continues already-claimed work from persisted ' + evidence + ' with no active Task', async t => {
    const { requests, record } = await coldSingletonContinuation(t, role, evidence)
    const continuation = requests.find((request: any) => request.role === role && request.id.startsWith('native-continuation:'))
    assert.ok(continuation, 'saved native unfinished work must produce its existing role continuation')
    assert.equal(continuation.taskId, record.lastWake.taskId)
    assert.equal(continuation.context.originalMessageId, record.delivery.messageId)
    assert.match(continuation.context.facts, /Inspect existing inputs/)
  })
  test('cold completed idle ' + role + ' with no unfinished native facts is not reopened', async t => {
    const { requests } = await coldSingletonContinuation(t, role, 'idle')
    assert.deepEqual(requests, [])
  })
}

import { captureCleanupInputs, captureCleanupReferences, cleanupRecordPath } from '../src/framework/cleaner.js'
test('runtime Cleaner requeues Recorder for changed original material, does not stop its active review, and releases only after new verified inputs', async t => {
  const { runtime, files, rows } = await runtimeFixture(t)
  const taskId = '77777777-7777-4777-8777-777777777777'
  const task = { version: 1 as const, taskId, route: 'P' as const, owner: 'A', sourcePath: 'tasks/completed_P.md', status: 'complete' as const, members: ['A'] }
  const originalPath = paths.member(taskId, 'A') + '/Reply.md', archivePath = paths.archive(taskId) + '/records.md', retentionPath = paths.archive(taskId) + '/retention.json'
  await withSnapshot(files, snapshot => files.commit(snapshot, [
    { path: paths.task(taskId), content: encodeJson(task) },
    { path: task.sourcePath, content: 'Task ID: ' + taskId + '\nOriginal requirement' },
    { path: originalPath, content: 'Original result at Recorder save' },
    { path: archivePath, content: 'Prior Recorder archive' },
    { path: paths.state('A', taskId) + '/Cleaner', content: '' },
  ], 'Completed Task original material'))
  const inputs = await withSnapshot(files, snapshot => captureCleanupInputs(files, snapshot, task))
  await withSnapshot(files, async snapshot => files.commit(snapshot, [{ path: retentionPath, content: encodeJson({ outputs: [archivePath], retainedPaths: [], inputs, verifiedReferences: await captureCleanupReferences(files, snapshot, [archivePath]), recorderCommand: 'original-save' }) }], 'Recorder original checked save'))
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: originalPath, content: 'Late exact original result not yet archived' }], 'Late original material'))
  const recorderKey = runtime.roleKey('Recorder', taskId), foregroundKey = runtime.roleKey('Foreground')
  await runtime.saveRole({ identity: { workId: recorderKey, executionId: 'prior-recorder', role: 'Recorder', taskId }, sessionId: 'recorder-session', generation: 1, stopped: true })
  await runtime.saveRole({ identity: { workId: foregroundKey, executionId: 'foreground-independent', role: 'Foreground' }, sessionId: 'foreground-session', generation: 1,
    lastWake: { id: 'result-notification', role: 'Foreground', taskId, reason: 'business-complete', sources: [] } })
  // Native ownership is a controlled port boundary here (AgentLoop is absent).
  // The real runtime active/stop ordering, durable Recorder queue, transactions,
  // material fingerprint, Cleaner deletion and local release execute unchanged.
  let reviewing = false, stopped = 0
  runtime.native = { get: (key: string) => key === recorderKey && reviewing ? { observe: () => ({ state: 'running' }) } : undefined,
    stop: async (key: string) => { assert.equal(key, recorderKey); stopped++; return { status: 'stopped' } } }
  const clean = () => withSnapshot(files, snapshot => runtime.clean(task, snapshot))
  assert.equal(await clean(), false)
  const pending = () => [...rows.values()].filter(row => row.request?.id.startsWith('recorder-materials:'))
  assert.equal(pending().length, 1)
  const arranged = pending()[0]!.request
  assert.equal(arranged.role, 'Recorder'); assert.equal(arranged.taskId, taskId)
  assert.deepEqual(arranged.context.changedOriginalPaths, [originalPath])
  await withSnapshot(files, async snapshot => {
    assert.equal(await files.read(snapshot, cleanupRecordPath(taskId)), undefined)
    assert.equal(await files.read(snapshot, originalPath), 'Late exact original result not yet archived')
  })
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: 'instances/unrelated-heartbeat.json', content: encodeJson({ sequence: 2 }) }], 'Unrelated heartbeat'))
  await assert.rejects(clean(), FilesConflictError, 'the saved failed preparation must first observe the intervening HEAD conflict')
  assert.equal(await clean(), false)
  assert.equal(pending().length, 1, 'material signature, not each HEAD, identifies the existing Recorder review')
  await runtime.saveRole({ identity: { workId: recorderKey, executionId: 'review-recorder', role: 'Recorder', taskId }, sessionId: 'recorder-review-session', generation: 2, lastWake: arranged })
  reviewing = true
  assert.equal(await clean(), false)
  assert.equal(stopped, 0, 'stale Cleaner signal cannot stop the Recorder currently reviewing the changed inputs')
  assert.equal(runtime.roleRecords.get(foregroundKey)?.stopped, undefined)
  reviewing = false
  const reviewedInputs = await withSnapshot(files, snapshot => captureCleanupInputs(files, snapshot, task))
  await withSnapshot(files, async snapshot => files.commit(snapshot, [
    { path: archivePath, content: 'Recorder now preserves late exact original result' },
    { path: retentionPath, content: encodeJson({ outputs: [archivePath], retainedPaths: [], inputs: reviewedInputs, verifiedReferences: await captureCleanupReferences(files, snapshot, [archivePath], [{ path: archivePath, content: 'Recorder now preserves late exact original result' }]), recorderCommand: 'review-save' }) },
  ], 'Recorder saves and confirms revised material'))
  assert.equal(await clean(), false, 'Recorder stop is owned without blocking the poll')
  await Promise.all([...runtime.stopOperations.values()].map((stop: any) => stop.promise))
  assert.equal(await clean(), true)
  assert.equal(stopped, 1)
  await withSnapshot(files, async snapshot => {
    assert.equal(await files.read(snapshot, originalPath), undefined)
    assert.equal(await files.read(snapshot, archivePath), 'Recorder now preserves late exact original result')
    assert.equal(JSON.parse((await files.read(snapshot, cleanupRecordPath(taskId)))!).phase, 'released')
  })
  assert.equal(runtime.roleRecords.has(recorderKey), false)
  assert.equal(runtime.roleRecords.get(foregroundKey)?.identity.executionId, 'foreground-independent')
})

async function routedNativeOpen(t: test.TestContext, routes: Record<string, unknown>) {
  const { runtime, errors } = await runtimeFixture(t), opened: Array<{ role: string; model: unknown }> = []
  Object.assign(runtime.config, routes)
  runtime.gateway = { exists: async () => false }
  // This is the runtime/native.open routing boundary, not a model response or a
  // real AgentLoop: the missing official concrete loop remains separately blocked.
  runtime.native = { get: () => undefined, open: async (identity: any, options: any) => {
    opened.push({ role: identity.role, model: options.model })
    return { send: async () => {} }
  } }
  await runtime.wake({ id: 'route-foreground', role: 'Foreground', reason: 'notification', sources: [] })
  await runtime.wake({ id: 'route-helper', role: 'Helper', reason: 'helper', sources: [] })
  await runtime.runQueue(); await runtime.errorTail
  assert.deepEqual(errors, [])
  return opened
}
test('runtime native.open keeps an explicit background route independent from Foreground', async t => {
  const foreground = { provider: 'controlled-front-provider', model: 'front-model', reasoningEffort: 'high' }
  const background = { provider: 'controlled-back-provider', model: 'back-model', reasoningEffort: 'low' }
  assert.deepEqual(await routedNativeOpen(t, { foreground, background, model: { provider: 'older-default', model: 'default-model' } }),
    [{ role: 'Foreground', model: foreground }, { role: 'Helper', model: background }])
})
test('runtime background Auto inherits the selected Foreground reasoning route and leaves all-undefined to the Host default', async t => {
  const foreground = { provider: 'controlled-provider', model: 'front-selected', reasoningEffort: 'high' }
  assert.deepEqual(await routedNativeOpen(t, { foreground, background: undefined, model: undefined }),
    [{ role: 'Foreground', model: foreground }, { role: 'Helper', model: foreground }])
  assert.deepEqual(await routedNativeOpen(t, { foreground: undefined, background: undefined, model: undefined }),
    [{ role: 'Foreground', model: undefined }, { role: 'Helper', model: undefined }])
})

import { Context as NativeContext } from '@deepseek-ai/cordis'
import type { Agent as NativeAgent } from '@deepseek-ai/dsh-agent'
import { createScope as createNativeScope } from '@deepseek-ai/dsh-scope'
import { ToolRuntime as NativeToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt as NativeSystemPrompt } from '@deepseek-ai/dsh-system-prompt'
/** Executes the production native.open setup against official Cordis scope/tool/
 * prompt registries. The event payload is the installed agent/error contract;
 * it has no terminal flag. AgentLoop execution itself remains a controlled port. */
async function installedErrorHook(t: test.TestContext, role: 'Foreground' | 'Helper') {
  const fixture = await runtimeFixture(t), { runtime, rows } = fixture
  const ctx = new NativeContext(), plugins = [await ctx.plugin(NativeToolRuntime), await ctx.plugin(NativeSystemPrompt)]
  const actual = { id: 'error-hook-agent', session: {} } as NativeAgent
  const injected = await new Promise<NativeContext>(resolve => { ctx.inject(['tools', 'systemPrompt'], child => { resolve(child) }) })
  const scoped = createNativeScope(injected, actual)
  let handler: ((event: { agent: NativeAgent; turn: number; step: number; error: unknown }) => void) | undefined
  const originalOn = scoped.ctx.on.bind(scoped.ctx)
  scoped.ctx.on = ((name: string, callback: any, ...rest: any[]) => {
    if (name === 'agent/error') handler = callback
    return (originalOn as any)(name, callback, ...rest)
  }) as typeof scoped.ctx.on
  runtime.gateway = { exists: async () => false }
  let installed = false
  runtime.native = { get: () => undefined, open: async (_identity: any, options: any) => {
    if (!installed) { options.setup(scoped.ctx, actual); installed = true }
    return { send: async () => {} }
  } }
  t.after(async () => { await scoped.dispose(); for (const plugin of plugins) await plugin.dispose() })
  await runtime.wake({ id: 'initial-' + role, role, reason: role === 'Helper' ? 'helper' : 'notification', sources: [] })
  await runtime.runQueue(); await runtime.errorTail
  assert.deepEqual(fixture.errors, [], 'native setup must finish without registration errors')
  assert.ok(handler, 'production setup must install the actual agent/error hook')
  assert.equal([...rows.values()].find(row => row.request?.id === 'initial-' + role)?.delivered, true)
  return { ...fixture, actual, emit: async (turn: number, step: number, error: Error) => {
    handler!({ agent: actual, turn, step, error }); await runtime.errorTail
  }, errorWakes: () => [...rows.values()].filter(row => row.request?.id.startsWith('host-error:')) }
}
test('native setup error hook preserves a delivered Helper failure without recursively dispatching another Helper', async t => {
  const { runtime, rows, emit, errors, errorWakes } = await installedErrorHook(t, 'Helper')
  const first = new Error('Helper native turn failed'), second = new Error('Helper next native turn failed')
  await emit(1, 0, first)
  await runtime.runQueue()
  await emit(2, 1, second)
  assert.deepEqual(errors, [first, second], 'environment diagnostics retain both actual failures')
  assert.equal(errorWakes().length, 0, 'Helper cannot schedule itself again after its durable wake was delivered')
  const preserved = [...rows].filter(([key]) => key.startsWith(runtime.prefix + 'helper-errors/')).map(([, value]) => value)
  assert.deepEqual(preserved.map(value => ({ facts: value.facts, role: value.context.identity.role, turn: value.context.turn, step: value.context.step })), [
    { facts: first.message, role: 'Helper', turn: 1, step: 0 },
    { facts: second.message, role: 'Helper', turn: 2, step: 1 },
  ], 'failure facts remain durable and attributed to the original native execution')
  assert.equal(preserved[0]!.context.identity.executionId, preserved[1]!.context.identity.executionId)
  assert.equal([...rows.values()].find(row => row.request?.id === 'initial-Helper')?.delivered, true, 'recording errors does not reset delivered work to runnable')
})
test('native setup error hook still arranges Helper for a non-Helper role failure', async t => {
  const { emit, errors, errorWakes } = await installedErrorHook(t, 'Foreground')
  const failure = new Error('Foreground native turn failed')
  await emit(1, 0, failure)
  assert.deepEqual(errors, [failure])
  assert.equal(errorWakes().length, 1)
  assert.equal(errorWakes()[0]!.request.role, 'Helper')
  assert.equal(errorWakes()[0]!.request.context.identity.role, 'Foreground')
})

// Fixed official Host source: agent-loop/index.ts dispose cancels with disposed;
// agent.ts clears inbox, drains the turn, and appends aborted/disposed. Do not
// fabricate queued inbox surviving normal disposal or equate user cancellation.
for (const role of ['Foreground', 'Helper'] as const) {
  test('explicit restart resumes stopped ' + role + ' with persisted Host-disposed unfinished turn', async t => {
    const { requests, record } = await coldSingletonContinuation(t, role, 'disposed', true)
    const continuation = requests.find((request: any) => request.role === role && request.id.startsWith('native-continuation:'))
    assert.ok(continuation, 'physical Host disposal is not a completed business response')
    assert.equal(continuation.context.originalMessageId, record.delivery.messageId)
    assert.match(continuation.context.facts, /Inspect existing inputs/)
  })
  for (const evidence of ['idle', 'user-aborted'] as const) test('explicit restart does not reopen stopped ' + role + ' after ' + evidence, async t => {
    const { requests } = await coldSingletonContinuation(t, role, evidence, true)
    assert.deepEqual(requests, [])
  })
}

for (const role of ['Foreground', 'Helper'] as const) test('explicit user execution stop prevents replay of Host-disposed ' + role + ' input', async t => {
  const { requests } = await coldSingletonContinuation(t, role, 'disposed', true, true)
  assert.deepEqual(requests, [])
})
for (const settled of [false, true]) test('queue with crash-persisted stop intent ' + (settled ? 'confirms exact native settlement before opening a new generation' : 'does not open while producer remains unconfirmed'), async t => {
  const { runtime, rows } = await runtimeFixture(t)
  const key = runtime.roleKey('Foreground')
  const record: any = coldStopRecord(key)
  record.identity = { workId: key, executionId: 'old-execution', role: 'Foreground' }
  record.lastWake = { id: 'old-delivered', role: 'Foreground', reason: 'notification', sources: [] }
  delete record.stopUnknown
  await runtime.saveRole(record)
  const history = coldHistory(runtime)
  if (settled) history.events.push({ type: 'job/settled', data: { owner: 'cold-session', jobId: 'owned-job', producerReported: true } })
  const opened: any[] = []
  runtime.gateway = { exists: async () => true }
  runtime.native.open = async (identity: any) => { opened.push(identity); return { send: async () => {} } }
  await runtime.wake({ id: 'new-after-restart', role: 'Foreground', reason: 'notification', sources: [] })
  await runtime.runQueue(); await runtime.errorTail
  assert.equal(opened.length, settled ? 1 : 0)
  assert.ok(history.reads > 0, 'queue must consult real durable native stop history')
  assert.equal(history.reads, history.closes)
  if (settled) {
    assert.notEqual(opened[0].executionId, 'old-execution')
    assert.equal(runtime.roleRecords.get(key).generation, 2)
    assert.equal(runtime.roleRecords.get(key).stopUnknown, undefined)
  } else {
    assert.deepEqual(runtime.roleRecords.get(key).stopUnknown.jobs, ['owned-job'])
    assert.equal([...rows.values()].find(row => row.request?.id === 'new-after-restart')?.delivered, undefined)
  }
})

for (const role of ['Helper', 'Foreground'] as const) test('native.open failure for ' + role + ' preserves the original queue responsibility without recursive Helper admission', async t => {
  const { runtime, rows, errors } = await runtimeFixture(t)
  const failure = new Error('Native setup or flush failed before agent/error emission')
  let attempts = 0
  runtime.gateway = { exists: async () => false }
  runtime.native = { get: () => undefined, open: async () => { attempts++; throw failure } }
  await runtime.wake({ id: 'original-open-' + role, role, reason: role === 'Helper' ? 'helper' : 'notification', sources: [] })
  await runtime.runQueue(); await runtime.errorTail
  const diagnosticWakes = () => [...rows.values()].filter(row => row.request?.id.startsWith('host-error:'))
  assert.equal(diagnosticWakes().length, role === 'Helper' ? 0 : 1)
  if (role === 'Helper') {
    // A later normal queue pass can retry that original responsibility. It must
    // not manufacture another diagnostic Agent responsibility on each failure.
    await runtime.runQueue(); await runtime.errorTail
    assert.equal(attempts, 2)
    assert.equal(diagnosticWakes().length, 0)
    assert.equal([...rows.values()].filter(row => row.request).length, 1)
    const diagnostics = [...rows].filter(([key]) => key.startsWith(runtime.prefix + 'helper-errors/')).map(([, value]) => value)
    assert.equal(diagnostics.length, 1, 'same failure context is durably retained, not recursively admitted')
    assert.equal(diagnostics[0]!.facts, failure.message)
  } else {
    assert.equal(diagnosticWakes()[0]!.request.role, 'Helper')
  }
  assert.equal([...rows.values()].find(row => row.request?.id === 'original-open-' + role)?.delivered, undefined)
  assert.equal(errors.length, attempts)
  assert.ok(errors.every(error => error === failure))
})

async function seatTask(runtime: any, files: any) {
  const taskId = '99999999-9999-4999-8999-999999999999'
  await withSnapshot(files, snapshot => files.commit(snapshot, [
    { path: paths.task(taskId), content: encodeJson({ version: 1, taskId, route: 'P', owner: 'A', sourcePath: 'tasks/seats_P.md', status: 'running' }) },
    { path: paths.memberStatus(taskId, 'A'), content: encodeJson({ state: 'running', deliveryId: '' }) },
  ], 'running Task for native seat admission'))
  runtime.gateway = { exists: async () => false }
  return taskId
}
for (const evidence of ['stopUnknown', 'stopIntent'] as const) test('Worker queue retains a seat for stopped native observation with unsettled ' + evidence, async t => {
  const { runtime, files, rows } = await runtimeFixture(t), taskId = await seatTask(runtime, files)
  runtime.updateWorkerSeats(1)
  const workId = runtime.roleKey('Worker', taskId, 'old')
  const identity = { workId, executionId: 'unsettled-worker', role: 'Worker', taskId, member: 'A', workerId: 'old' }
  await runtime.saveRole({ identity, sessionId: 'unsettled-session', generation: 1,
    ...(evidence === 'stopUnknown' ? { stopUnknown: { reason: 'producer not settled', jobs: ['owned-job'] } }
      : { stopIntent: { workId, executionId: identity.executionId, agentId: 'unsettled-session', sessionId: 'unsettled-session', phase: 'stopping', jobs: ['owned-job'] } }) })
  let opened = 0
  runtime.native = { get: () => ({ observe: () => ({ state: 'stopped' }) }), open: async () => { opened++; return { send: async () => {} } },
    stop: async () => { assert.fail('admission must not automatically repeat another Worker stop') } }
  await runtime.wake({ id: 'other-worker-' + evidence, role: 'Worker', taskId, workerId: 'new', reason: 'notification', sources: [] })
  await runtime.runQueue(); await runtime.errorTail
  assert.equal(opened, 0, 'unconfirmed producer still owns its physical seat even though observe is stopped')
  assert.equal([...rows.values()].find(row => row.request?.id === 'other-worker-' + evidence)?.delivered, undefined)
})
test('hot seat reduction 4 to 1 does not stop in-flight Workers and admits later work only after capacity is actually free', async t => {
  const { runtime, files } = await runtimeFixture(t), taskId = await seatTask(runtime, files)
  runtime.updateWorkerSeats(4)
  const running = new Set<string>()
  for (let i = 0; i < 4; i++) {
    const workId = runtime.roleKey('Worker', taskId, 'worker-' + i); running.add(workId)
    await runtime.saveRole({ identity: { workId, executionId: 'execution-' + i, role: 'Worker', taskId, member: 'A', workerId: 'worker-' + i }, sessionId: 'session-' + i, generation: 1 })
  }
  let opened = 0, stopped = 0
  runtime.native = { get: (id: string) => ({ observe: () => ({ state: running.has(id) ? 'running' : 'stopped' }) }),
    stop: async () => { stopped++; return { status: 'stopped' } }, open: async () => { opened++; return { send: async () => {} } } }
  runtime.updateWorkerSeats(1)
  assert.equal(stopped, 0)
  assert.equal(running.size, 4)
  await runtime.wake({ id: 'after-capacity-change', role: 'Worker', taskId, workerId: 'future', reason: 'notification', sources: [] })
  await runtime.runQueue(); assert.equal(opened, 0)
  for (const id of [...running]) {
    running.delete(id)
    await runtime.runQueue()
    assert.equal(opened, running.size === 0 ? 1 : 0)
  }
  assert.equal(stopped, 0, 'capacity update never cancels already admitted producers')
})

test('same Worker replacement reconciles its own stop intent before checking whether that old execution still occupies capacity', async t => {
  const { runtime, files } = await runtimeFixture(t), taskId = await seatTask(runtime, files)
  runtime.updateWorkerSeats(1)
  const key = runtime.roleKey('Worker', taskId, 'child'), record = coldStopRecord(key)
  record.identity.taskId = taskId
  delete (record as any).stopUnknown
  await runtime.saveRole(record)
  const history = coldHistory(runtime)
  history.events.push({ type: 'job/settled', data: { owner: 'cold-session', jobId: 'owned-job', producerReported: true } })
  let opened: any
  runtime.native.open = async (identity: any) => { opened = identity; return { send: async () => {} } }
  await runtime.wake({ id: 'same-worker-replacement', role: 'Worker', taskId, workerId: 'child', reason: 'notification', sources: [] })
  await runtime.runQueue(); await runtime.errorTail
  assert.ok(history.reads > 0, 'its own occupancy cannot block the exact old-producer settlement check')
  assert.ok(opened)
  assert.notEqual(opened.executionId, record.identity.executionId)
  assert.equal(runtime.roleRecords.get(key).generation, 2)
  assert.equal(runtime.roleRecords.get(key).stopUnknown, undefined)
})


test('one unreadable cold singleton session preserves its facts without blocking other startup recovery', async t => {
  const { runtime, files, rows, errors } = await runtimeFixture(t)
  await recoveryTasks(files)
  const failure = new Error('Persisted Foreground session cannot be read')
  const record = (role: 'Foreground' | 'Recorder') => ({
    identity: { workId: runtime.roleKey(role, role === 'Recorder' ? 'completed-T' : undefined), executionId: role + '-execution', role,
      ...(role === 'Recorder' ? { taskId: 'completed-T' } : {}) },
    sessionId: role + '-session', generation: 1,
    lastWake: { id: role + '-original', role, taskId: 'completed-T', reason: 'business-complete', sources: [] },
  })
  const foreground = record('Foreground'), recorder = record('Recorder')
  await runtime.saveRole(foreground); await runtime.saveRole(recorder)
  let closed = 0
  const events = [{ seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } }]
  const persistence = {
    stat: async (id: string) => { if (id === foreground.sessionId) throw failure; return { sizeBytes: 42 } },
    open: async (id: string, mode: string) => {
      assert.equal(id, recorder.sessionId); assert.equal(mode, 'read')
      return { header: { version: 4, id, createdAt: 0 }, inheritedEventCount: 0,
        read: async () => ({ events }), close: async () => { closed++ } }
    },
  }
  runtime.ctx = { agents: { get: () => undefined }, sessions: { get: () => undefined }, jobs: { list: () => [] },
    get: (name: string) => name === 'sessionPersistence' ? persistence : name === 'sessionProjections'
      ? { restore: () => ({ checkpoint: { inbox: { val: { 'next-turn': [], 'next-step': [] } }, turnBoundary: { val: {} } } }) } : undefined }
  runtime.pump = async () => {} // Actual durable arrangement only; no native Agent/model claim.
  await runtime.startup(); await runtime.errorTail
  const requests = [...rows.values()].filter(row => row.request).map(row => row.request)
  assert.deepEqual(requests.filter(request => request.role === 'Planner').map(request => request.taskId).sort(), ['broken-T', 'valid-T'])
  assert.ok(requests.some(request => request.role === 'Recorder' && request.reason === 'startup-recovery'))
  assert.ok(!requests.some(request => request.role === 'Foreground'), 'unreadable history is not proof of unfinished work')
  assert.ok(requests.some(request => request.role === 'Helper' && request.context?.sessionId === foreground.sessionId
    && request.context?.identity.executionId === foreground.identity.executionId))
  assert.deepEqual(runtime.roleRecords.get(foreground.identity.workId), foreground, 'do not mark the unreadable execution stopped or complete')
  assert.ok(errors.includes(failure)); assert.equal(closed, 1)
})


test('uncertain native delivery retries its persisted original payload after resources change', async t => {
  const { runtime, rows } = await runtimeFixture(t)
  const sent: Array<{ text: string; id: string }> = []
  let attempts = 0
  runtime.gateway = { exists: async () => false }
  runtime.native = { get: () => ({ observe: () => ({ state: 'idle' }) }),
    open: async () => ({ send: async (text: string, id: string) => {
      sent.push({ text, id }); if (++attempts === 1) throw new Error('native admission outcome unknown')
    } }) }
  runtime.environment.resources = () => [{ member: 'A', workerSeats: 2, availability: 'online' }]
  await runtime.wake({ id: 'stable-input', role: 'Helper', reason: 'helper', sources: [], context: { facts: 'original diagnostic' } })
  await runtime.runQueue(); await runtime.errorTail
  const original = runtime.roleRecords.get(runtime.roleKey('Helper')).delivery
  assert.equal(original.text, sent[0]!.text)
  assert.equal(original.confirmed, false)
  runtime.updateWorkerSeats(1)
  runtime.environment.resources = () => [{ member: 'A', workerSeats: 1, availability: 'offline' }, { member: 'B', workerSeats: 4, availability: 'online' }]
  await runtime.runQueue()
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[1], sent[0], 'same message ID must keep exactly the same text, not a newly assembled resource view')
  const confirmed = runtime.roleRecords.get(runtime.roleKey('Helper')).delivery
  assert.equal(confirmed.confirmed, true); assert.equal(confirmed.text, original.text)
  assert.equal([...rows.values()].find(row => row.request?.id === 'stable-input').delivered, true)
})

test('healthy assessment uses the observation writer and persists member receipt with its reset', async () => {
  const { runtime, rows } = queue()
  runtime.conversation = { foregroundRoot: 'foreground' }
  runtime.environment = {}
  const calls: unknown[] = []
  runtime.observations = { healthyCycle: async (...args: unknown[]) => { calls.push(args) } }
  const member = { taskId: 'T', member: 'A' }
  const key = runtime.watchKey('T', 'A')
  rows.set(key, { watch: { ...member, stage: 3, cycleStartedAt: 0, stageStartedAt: 0 }, consumedReceipts: ['old-consumption'] })
  const input = { workId: 'worker', member, continuouslyNormal: true, noNewRecoveryAnomaly: true }
  const originalSet = runtime.records.set
  let loseAcknowledgement = true
  runtime.records.set = async (path: string, value: unknown) => {
    if (path.startsWith('test/healthy/') && loseAcknowledgement) { loseAcknowledgement = false; throw new Error('receipt acknowledgement lost') }
    await originalSet(path, value)
  }
  await assert.rejects(runtime.services().helper.healthyCycle(input, 'healthy-command'), /acknowledgement lost/)
  assert.deepEqual(calls[0], ['worker', input, 'healthy-command'])
  const saved = rows.get(key)
  assert.equal(saved.watch.stage, 0)
  assert.deepEqual(saved.consumedReceipts, ['old-consumption'])
  assert.deepEqual(saved.completedHealthyCycles, ['healthy-command'])
  // A later cycle must survive a retry after the separate acknowledgement failed.
  rows.set(key, { ...saved, watch: { ...member, stage: 3, cycleStartedAt: 123, stageStartedAt: 456 } })
  await runtime.services().helper.healthyCycle(input, 'healthy-command')
  assert.equal(rows.get(key).watch.stage, 3)
  assert.equal(rows.get(key).watch.cycleStartedAt, 123)
})

test('member consumption serializes behind the active watch writer and retains healthy receipts', async () => {
  const { runtime, rows } = queue()
  runtime.conversation = { foregroundRoot: 'foreground' }; runtime.environment = {}
  runtime.observations = { recoveryConsumed: async () => undefined }
  const member = { taskId: 'T', member: 'A' }, key = runtime.watchKey('T', 'A')
  let release!: () => void, started!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { started = resolve })
  const writer = runtime.serialRecoveryWatch('T', 'A', async (path: string) => {
    started(); await waiting
    await runtime.records.set(path, { watch: { ...member, stage: 1, cycleStartedAt: 0, stageStartedAt: 1 }, completedHealthyCycles: ['healthy-old'] })
  })
  await entered
  const consume = runtime.services().afterRecoveryConsumed({ role: 'Planner', ...member }, member, { operationId: 'consumed' })
  release(); await Promise.all([writer, consume])
  assert.equal(rows.get(key).watch, undefined)
  assert.deepEqual(rows.get(key).completedHealthyCycles, ['healthy-old'])
  assert.deepEqual(rows.get(key).consumedReceipts, ['consumed'])
})

test('marker observation queued behind consumption does not revive an old snapshot or released watch', async t => {
  const { runtime, files, rows } = await runtimeFixture(t)
  const taskId = '99999999-9999-4999-8999-999999999999'
  const marker = paths.state('A', taskId) + '/recovery'
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: marker, content: '' }], 'marker'))
  let release!: () => void, enumerated!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const listed = new Promise<void>(resolve => { enumerated = resolve })
  runtime.taskMetadata = async () => { enumerated(); return [{ taskId, status: 'running', owner: 'A', members: ['A'] }] }
  const blocking = runtime.serialRecoveryWatch(taskId, 'A', async () => { await waiting })
  const observation = runtime.observeRecoveryMarkers()
  await listed
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: marker, content: null }], 'Planner consumed marker'))
  release(); await Promise.all([blocking, observation])
  assert.equal(rows.get(runtime.watchKey(taskId, 'A'))?.watch, undefined)
  rows.set(runtime.watchKey(taskId, 'A'), { released: true, completedHealthyCycles: ['old'] })
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: marker, content: '' }], 'retained historical marker'))
  await runtime.observeRecoveryMarkers()
  assert.deepEqual(rows.get(runtime.watchKey(taskId, 'A')), { released: true, completedHealthyCycles: ['old'] })
})

test('healthy member assessment cannot acknowledge a nonexistent watch', async () => {
  const { runtime, rows } = queue()
  runtime.conversation = { foregroundRoot: 'foreground' }; runtime.environment = {}
  await assert.rejects(runtime.services().helper.healthyCycle({ member: { taskId: 'T', member: 'A' },
    continuouslyNormal: true, noNewRecoveryAnomaly: true }, 'absent-watch'), /watch does not exist/)
  assert.equal(rows.size, 0)
})

test('released Task stops participating in sealed stop work across restart while other unresolved work remains', async () => {
  const { runtime, rows } = queue()
  runtime.roleRecords = new Map()
  runtime.observations = { unbind: async () => undefined }
  await runtime.sealBusiness('T1'); await runtime.sealBusiness('T2')
  await runtime.releaseTask({ taskId: 'T1', owner: 'A', members: ['A'] })
  const checked: string[] = [], errors: unknown[] = []
  runtime.businessStopped = (taskId: string) => { checked.push(taskId); runtime.error(new Error('producer unconfirmed')); return false }
  runtime.error = (error: unknown) => errors.push(error)
  await runtime.processSealedBusiness()
  // A new runtime object reads the same durable records after a Host restart.
  const restarted = queue().runtime
  restarted.records = runtime.records; restarted.businessStopped = runtime.businessStopped; restarted.error = runtime.error
  await restarted.sealBusiness('T1')
  await restarted.processSealedBusiness()
  assert.deepEqual(checked, ['T2', 'T2'])
  assert.equal(errors.length, 2)
  assert.equal([...rows.values()].some(value => value.taskId === 'T1' && value.released === true), true)
})

test('Organizer task pause and native admission share one work operation order', async t => {
  const { runtime } = await runtimeFixture(t)
  const events: string[] = [], messages = new Set<string>()
  runtime.error = (error: unknown) => { throw error }
  runtime.gateway = { exists: async () => false }
  runtime.native = {
    get: () => ({ observe: () => ({ state: 'idle' }), hasMessage: (id: string) => messages.has(id) }),
    open: async () => ({ send: async (body: string, id: string) => { events.push('send:' + JSON.parse(body).taskId); messages.add(id) } }),
    stop: async () => { events.push('stop'); return { status: 'stopped' } },
  }
  await runtime.wake({ id: 'A-before-pause', role: 'Organizer', taskId: 'A', reason: 'user-resume', sources: [] })
  await runtime.runQueue()
  await runtime.controls.setTask('pause-A', 'A', 'paused')
  const originalHeld = runtime.controls.taskHeld.bind(runtime.controls)
  let entered!: () => void, release!: () => void
  const checkingA = new Promise<void>(resolve => { entered = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  runtime.controls.taskHeld = async (taskId: string) => {
    if (taskId === 'A') { entered(); await blocked }
    return originalHeld(taskId)
  }
  const pause = runtime.applyUserControls()
  await checkingA
  await runtime.wake({ id: 'B-after-A', role: 'Organizer', taskId: 'B', reason: 'user-resume', sources: [] })
  const admission = runtime.runQueue()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(events, ['send:A'], 'B cannot be admitted between A ownership check and its stop')
  release(); await Promise.all([pause, admission])
  await runtime.runQueue()
  assert.deepEqual(events, ['send:A', 'stop', 'send:B'])
  assert.equal(runtime.roleRecords.get(runtime.roleKey('Organizer')).lastWake.taskId, 'B')
  await runtime.applyUserControls()
  assert.deepEqual(events, ['send:A', 'stop', 'send:B'], 'old A pause cannot stop the new B responsibility')
})

test('a busy work leaves its wake pending without blocking another Worker admission', async t => {
  const { runtime } = await runtimeFixture(t), sent: string[] = []
  runtime.gateway = { exists: async () => false }
  runtime.native = { get: () => undefined, open: async () => ({ send: async (text: string) => { sent.push(JSON.parse(text).taskId) } }) }
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const busy = runtime.serialWork(runtime.roleKey('Worker', 'T1', 'W1'), async () => waiting)
  await runtime.wake({ id: 'busy-W1', role: 'Worker', taskId: 'T1', workerId: 'W1', reason: 'user-resume', sources: [] })
  await runtime.wake({ id: 'free-W2', role: 'Worker', taskId: 'T2', workerId: 'W2', reason: 'user-resume', sources: [] })
  try { await runtime.runQueue(); assert.deepEqual(sent, ['T2']) }
  finally { release(); await busy }
  await runtime.runQueue()
  assert.deepEqual(sent, ['T2', 'T1'])
})

test('Foreground admission delay does not block exact Worker stop', async t => {
  const { runtime } = await runtimeFixture(t), stopped: string[] = []
  const foreground = { identity: { role: 'Foreground', workId: 'f', executionId: 'fe' }, sessionId: 'fs', generation: 1 }
  const worker = { identity: { role: 'Worker', workId: 'w', executionId: 'we', taskId: 'T' }, sessionId: 'ws', generation: 1 }
  runtime.roleRecords.set('f', foreground); runtime.roleRecords.set('w', worker)
  runtime.native = { stop: async (workId: string) => { stopped.push(workId); return { status: 'stopped' } } }
  await runtime.controls.requestExecutionStop('stop-w', { workId: 'w', executionId: 'we', taskId: 'T' })
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const busy = runtime.serialWork('f', async () => waiting)
  const controls = runtime.applyUserControls()
  try { await new Promise<void>(resolve => setImmediate(resolve)); assert.deepEqual(stopped, ['w']) }
  finally { release(); await Promise.all([busy, controls]) }
})

test('a Host closed before an admitted work callback starts cannot open a native execution', async t => {
  const { runtime } = await runtimeFixture(t)
  runtime.gateway = { exists: async () => { throw new Error('closed Host inspected a new execution') } }
  runtime.native = { get: () => undefined, open: async () => { throw new Error('closed Host opened a native execution') } }
  const original = runtime.serialWork.bind(runtime)
  runtime.serialWork = (workId: string, operation: () => Promise<void>) => original(workId, async () => { runtime.closed = true; await operation() })
  await runtime.wake({ id: 'closed-before-callback', role: 'Organizer', taskId: 'T', reason: 'user-resume', sources: [] })
  await runtime.runQueue()
  assert.equal(runtime.roleRecords.size, 0)
})

for (const state of ['queued', 'consumed', 'claimed', 'discarded'] as const) test('recovery arrangement selects native B instead of old Organizer A: ' + state, async t => {
  const { runtime, rows } = await runtimeFixture(t)
  const original = { id: 'B-original', role: 'Organizer', taskId: 'B', reason: 'notification', sources: [] }
  const record = { identity: { workId: runtime.roleKey('Organizer'), executionId: 'e-before-crash', role: 'Organizer' }, sessionId: 'original-session', generation: 1,
    lastWake: { ...original, id: 'A-old', taskId: 'A' }, delivery: { request: original, messageId: 'native-B', text: 'exact B', confirmed: false } }
  t.mock.method(DshSessionReader.prototype, 'inputs', async () => new Map([['native-B', { state, active: false, text: 'exact B', source: 'deepseek-servant' }]]))
  const inspection = { lastTurn: { turn: 4, closed: false } }
  const first = await runtime.arrangeNativeContinuation(record, { facts: 'one native interruption' }, inspection)
  const second = await runtime.arrangeNativeContinuation(record, { facts: 'one native interruption' }, inspection)
  assert.equal(first.taskId, 'B'); assert.equal(first.id, second.id)
  const recovery = [...rows.values()].filter(row => row.recovery)
  assert.equal(recovery.length, 1)
  assert.equal(recovery[0].recovery.original.messageId, 'native-B')
  assert.equal(recovery[0].recovery.original.text, 'exact B')
  assert.equal(JSON.stringify(first.context).includes('exact B'), false, 'recovery explanation does not copy business input text')
})
test('a pending recovery explanation reuses its durable identity/body through a second restart', async t => {
  const { runtime, rows } = await runtimeFixture(t)
  const request = { id: 'stable-R', role: 'Organizer', taskId: 'B', reason: 'startup-recovery', sources: [], context: { facts: 'original recovery explanation' } }
  const metadata = { targetExecutionId: 'old-execution', explanationText: 'original R body' }
  await runtime.wake(request, metadata)
  const record = { identity: { workId: runtime.roleKey('Organizer'), executionId: 'restarted-execution', role: 'Organizer' }, sessionId: 'same-session', generation: 2,
    delivery: { request, messageId: 'native-R', text: 'original R body', confirmed: true } }
  t.mock.method(DshSessionReader.prototype, 'inputs', async () => new Map([['native-R', { state: 'queued', text: 'original R body', source: 'deepseek-servant' }]]))
  const result = await runtime.arrangeNativeContinuation(record, { facts: 'a second discovery of the pending explanation' }, { lastTurn: { turn: 5 } })
  assert.equal(result.id, 'stable-R')
  const all = [...rows.values()].filter(row => row.recovery)
  assert.equal(all.length, 1); assert.equal(all[0].recovery.explanationText, 'original R body')
})
test('explicit user stop excludes recovery arrangement before inspecting or replaying input', async t => {
  const { runtime, rows } = await runtimeFixture(t)
  const record = { identity: { workId: 'w', executionId: 'stopped-by-user', role: 'Helper' }, sessionId: 's', generation: 1,
    lastWake: { id: 'work', role: 'Helper', reason: 'helper', sources: [] } }
  await runtime.controls.requestExecutionStop('user-stop', { workId: 'w', executionId: 'stopped-by-user' })
  t.mock.method(DshSessionReader.prototype, 'inputs', async () => { throw new Error('must not inspect a stopped input for automatic recovery') })
  assert.equal(await runtime.arrangeNativeContinuation(record, { facts: 'stale recovery request' }), undefined)
  assert.equal([...rows.values()].filter(row => row.recovery).length, 0)
})

test('a total-complete Task cannot reopen Organizer business while a different Task can proceed', async t => {
  const { runtime, files } = await runtimeFixture(t), sent: string[] = []
  await withSnapshot(files, snapshot => files.commit(snapshot, [
    { path: paths.task('T1'), content: encodeJson({ version: 1, taskId: 'T1', route: 'O', owner: 'A', status: 'complete', sourcePath: 'tasks/old_O.md', members: ['A'] }) },
    { path: paths.task('T2'), content: encodeJson({ version: 1, taskId: 'T2', route: 'O', owner: 'A', status: 'running', sourcePath: 'tasks/new_O.md', members: ['A', 'B'] }) },
    { path: paths.memberStatus('T2', 'A'), content: encodeJson({ state: 'complete', deliveryId: 'owner-finished' }) },
  ], 'one retired and one live Organizer responsibility'))
  runtime.gateway = { exists: async () => false }
  runtime.native = { get: () => undefined, open: async () => ({ send: async (text: string) => { sent.push(JSON.parse(text).taskId) } }) }
  await runtime.wake({ id: 'old-O-recovery', role: 'Organizer', taskId: 'T1', reason: 'startup-recovery', sources: [] })
  await runtime.wake({ id: 'live-O-work', role: 'Organizer', taskId: 'T2', reason: 'user-resume', sources: [] })
  await runtime.runQueue()
  assert.deepEqual(sent, ['T2'], 'owner member completion does not seal Organizer acceptance for the running Task')
})

for (const role of ['Planner', 'Worker'] as const) for (const state of ['queued', 'claimed', 'consumed', 'discarded'] as const) {
  test(`member startup preserves native ${role} input responsibility: ${state}`, async t => {
    const { runtime, files, rows } = await runtimeFixture(t)
    const taskId = 'member-restart', workerId = role === 'Worker' ? 'child' : undefined
    await withSnapshot(files, snapshot => files.commit(snapshot, [
      { path: paths.task(taskId), content: encodeJson({ version: 1, taskId, route: 'P', owner: 'A', sourcePath: 'tasks/member_P.md', status: 'running', members: ['A'] }) },
      { path: paths.inbox(taskId, 'A'), content: 'Preserved member responsibility' },
      { path: paths.memberStatus(taskId, 'A'), content: encodeJson({ state: 'running', deliveryId: 'original' }) },
      ...(workerId ? [{ path: paths.member(taskId, 'A') + '/workers/child/notes.md', content: 'Worker continuation facts' }] : []),
    ], 'recoverable member material'))
    const request = { id: 'original-member-input', role, taskId, workerId, reason: 'notification', sources: [{ path: 'state/A/member-restart/Planner', version: 'original' }] }
    const record = { identity: { workId: runtime.roleKey(role, taskId, workerId), executionId: 'old-member-execution', role, taskId, member: 'A', workerId },
      sessionId: 'member-session', generation: 1, lastWake: request, delivery: { request, messageId: 'native-member-B', text: 'original member input bytes', confirmed: true } }
    await runtime.saveRole(record)
    t.mock.method(DshSessionReader.prototype, 'inputs', async () => new Map([['native-member-B', { state, text: 'original member input bytes', source: 'deepseek-servant', active: false }]]))
    t.mock.method(DshSessionReader.prototype, 'inspect', async () => ({ exists: true, lifecycleKnown: true, lastTurn: { turn: 3, closed: false }, unresolvedToolCallIds: [], queuedInbox: { nextTurn: [], nextStep: [] } }) as any)
    runtime.pump = async () => {} // Verify durable runtime arrangement; native consumption is a separate boundary.
    await runtime.startup(); await runtime.startup()
    const wakes = [...rows.values()].filter(row => row.request?.role === role && row.request?.taskId === taskId)
    assert.equal(wakes.length, 1)
    assert.equal(wakes[0].recovery?.targetExecutionId, record.identity.executionId)
    assert.equal(wakes[0].recovery.original.messageId, 'native-member-B')
    assert.equal(wakes[0].recovery.original.text, 'original member input bytes')
    assert.equal(wakes[0].request.context.nativeInputState, state)
  })
}

test('member material without a saved native delivery keeps a stable owned recovery while a new member uses its notes directly', async t => {
  const { runtime, files, rows } = await runtimeFixture(t)
  await recoveryTasks(files)
  const record = { identity: { workId: runtime.roleKey('Planner', 'valid-T'), executionId: 'created-before-delivery', role: 'Planner', taskId: 'valid-T', member: 'A' }, sessionId: 'undelivered-session', generation: 1 }
  await runtime.saveRole(record)
  t.mock.method(DshSessionReader.prototype, 'inspect', async () => ({ exists: false }) as any)
  runtime.pump = async () => {}
  await runtime.startup(); await runtime.startup()
  const owned = [...rows.values()].filter(row => row.request?.taskId === 'valid-T')
  assert.equal(owned.length, 1)
  assert.equal(owned[0].recovery.targetExecutionId, record.identity.executionId)
  assert.equal(owned[0].recovery.original, undefined, 'no native input is invented')
  assert.equal(owned[0].request.context.nativeInputState, 'unknown')
  const fresh = [...rows.values()].find(row => row.request?.taskId === 'broken-T')
  assert.equal(fresh.request.role, 'Planner'); assert.equal(fresh.recovery, undefined)
})
test('unreadable member native session preserves its work and does not block another member recovery', async t => {
  const { runtime, files, rows, errors } = await runtimeFixture(t)
  await recoveryTasks(files)
  await runtime.saveRole({ identity: { workId: runtime.roleKey('Planner', 'broken-T'), executionId: 'broken-member-execution', role: 'Planner', taskId: 'broken-T', member: 'A' }, sessionId: 'broken-member-session', generation: 1 })
  t.mock.method(DshSessionReader.prototype, 'inspect', async () => { throw new Error('member native history unavailable') })
  runtime.pump = async () => {}
  await runtime.startup(); await runtime.errorTail
  assert.ok(![...rows.values()].some(row => row.request?.taskId === 'broken-T'))
  assert.ok([...rows.values()].some(row => row.request?.taskId === 'valid-T' && row.request.role === 'Planner'))
  assert.ok(errors.some(error => error instanceof Error && error.message === 'member native history unavailable'))
  await withSnapshot(files, async snapshot => assert.equal(await files.read(snapshot, paths.inbox('broken-T', 'A')), 'Original recoverable work broken-T'))
})

test('user resume follows admitted Organizer B rather than its previous A responsibility', async t => {
  const { runtime, rows } = await runtimeFixture(t)
  const old = { id: 'O-A', role: 'Organizer', taskId: 'A', reason: 'notification', sources: [] }
  const pending = { ...old, id: 'O-B', taskId: 'B' }
  const record = { identity: { workId: runtime.roleKey('Organizer'), executionId: 'paused-O', role: 'Organizer' }, sessionId: 'O-session', generation: 1, stopped: true,
    lastWake: old, delivery: { request: pending, messageId: 'native-B', text: 'Original B', confirmed: false } }
  await runtime.saveRole(record)
  runtime.native = { get: () => ({ hasMessage: (id: string) => id === 'native-B' }) }
  t.mock.method(DshSessionReader.prototype, 'inputs', async () => new Map([['native-B', { state: 'discarded', text: 'Original B', source: 'deepseek-servant', active: false }]]))
  t.mock.method(DshSessionReader.prototype, 'inspect', async () => ({ exists: true, lastTurn: { turn: 2, closed: true } }) as any)
  runtime.pump = async () => {}
  await runtime.resumeTask('A', 'wrong-task'); await runtime.resumeTask('B', 'resume-B')
  const wakes = [...rows.values()].filter(row => row.request?.role === 'Organizer')
  assert.deepEqual(wakes.map(row => row.request.taskId), ['B'])
  assert.equal(wakes[0].recovery.original.messageId, 'native-B')
  assert.equal(wakes[0].request.context.userRequestedResume, true)
})
test('Helper overall restoration supersedes the previous pending explanation without dropping its stop evidence', async t => {
  const { runtime, rows } = await runtimeFixture(t)
  const request = { id: 'old-deep-dive', role: 'Helper', reason: 'startup-recovery', sources: [], context: { facts: 'previous deep investigation' } }
  const record = { identity: { workId: runtime.roleKey('Helper'), executionId: 'old-helper', role: 'Helper' }, sessionId: 'helper-session', generation: 1,
    lastWake: request, delivery: { request, messageId: 'old-R', text: 'previous explanation', confirmed: true } }
  await runtime.saveRole(record); await runtime.wake(request, { targetExecutionId: 'prior-helper' })
  runtime.observations = { mayApply: async () => true }
  runtime.native = { stop: async () => ({ status: 'stopped' }) }
  t.mock.method(DshSessionReader.prototype, 'inputs', async () => new Map([['old-R', { state: 'queued', text: 'previous explanation', source: 'deepseek-servant' }]]))
  t.mock.method(DshSessionReader.prototype, 'inspect', async () => ({ exists: true, lastTurn: { turn: 4, closed: false } }) as any)
  const pending = { id: 'actual-overall-stage', action: { kind: 'restore-helper', identity: record.identity, elapsedMs: 2400000 } }
  await runtime.arrangeObservation(pending); await runtime.arrangeObservation(pending)
  const wakes = [...rows.values()].filter(row => row.request?.id === 'overall-restore:actual-overall-stage')
  assert.equal(wakes.length, 1)
  assert.equal(wakes[0].request.context.overallRestoration, true)
  assert.equal(wakes[0].recovery?.targetExecutionId, 'old-helper')
  assert.equal(wakes[0].recovery.original.messageId, 'old-R')
})

for (const exactStop of [false, true]) test(`Worker user resume preserves cancelled input unless its precise execution was explicitly stopped: ${exactStop}`, async t => {
  const { runtime, files, rows } = await runtimeFixture(t)
  await recoveryTasks(files)
  await withSnapshot(files, snapshot => files.commit(snapshot, [{ path: paths.member('valid-T', 'A') + '/workers/child/notes.md', content: 'unfinished Worker details' }], 'Worker continuation'))
  const request = { id: 'old-worker', role: 'Worker', taskId: 'valid-T', workerId: 'child', reason: 'notification', sources: [] }
  const record = { identity: { workId: runtime.roleKey('Worker', 'valid-T', 'child'), executionId: 'paused-worker', role: 'Worker', taskId: 'valid-T', member: 'A', workerId: 'child' },
    sessionId: 'worker-session', generation: 1, stopped: true, lastWake: request, delivery: { request, messageId: 'original-worker', text: 'exact Worker assignment', confirmed: true } }
  await runtime.saveRole(record)
  if (exactStop) await runtime.controls.requestExecutionStop('explicit-stop', { workId: record.identity.workId, executionId: record.identity.executionId })
  t.mock.method(DshSessionReader.prototype, 'inputs', async () => new Map([['original-worker', { state: 'discarded', text: 'exact Worker assignment', source: 'deepseek-servant' }]]))
  t.mock.method(DshSessionReader.prototype, 'inspect', async () => ({ exists: true, lastTurn: { turn: 2, closed: true } }) as any)
  runtime.pump = async () => {}
  await runtime.resumeTask('valid-T', 'user-continue'); await runtime.resumeTask('valid-T', 'user-continue')
  const wakes = [...rows.values()].filter(row => row.request?.role === 'Worker')
  assert.equal(wakes.length, exactStop ? 0 : 1)
  if (!exactStop) { assert.equal(wakes[0].recovery.original.text, 'exact Worker assignment'); assert.equal(wakes[0].request.reason, 'user-resume') }
})
test('pending overall continuation owns the old explanation without dispatching it twice or blocking another work', async t => {
  const { runtime, rows } = await runtimeFixture(t), sent: any[] = []
  const old = { id: 'old-R', role: 'Helper', reason: 'startup-recovery', sources: [], context: { deepInvestigation: true } }
  const next = { id: 'overall-R', role: 'Helper', reason: 'observation', sources: [], context: { overallRestoration: true } }
  await runtime.saveRole({ identity: { workId: runtime.roleKey('Helper'), executionId: 'stopped-helper', role: 'Helper' }, sessionId: 'helper-session', generation: 1, stopped: true })
  await runtime.wake(old)
  await runtime.wake(next, { targetExecutionId: 'stopped-helper', confirmedStoppedExecutions: ['stopped-helper'], original: { request: old, messageId: 'native-old-R', text: 'old explanation', confirmed: true } })
  await runtime.wake({ id: 'independent-front', role: 'Foreground', reason: 'notification', sources: [] })
  runtime.gateway = { exists: async () => false }
  runtime.native = { get: () => undefined, open: async (identity: any) => ({ send: async (text: string, id: string, mode: string) => sent.push({ role: identity.role, text: JSON.parse(text), mode }) }) }
  t.mock.method(DshSessionReader.prototype, 'inputs', async () => new Map([['native-old-R', { state: 'queued', text: 'old explanation', source: 'deepseek-servant' }]]))
  await runtime.runQueue()
  assert.equal(sent.filter(row => row.role === 'Helper').length, 1)
  assert.equal(sent.find(row => row.role === 'Helper').text.context.overallRestoration, true)
  assert.equal(sent.find(row => row.role === 'Helper').mode, 'steer')
  assert.equal(sent.find(row => row.role === 'Foreground').mode, 'followup')
  assert.ok(sent.some(row => row.role === 'Foreground'))
  assert.equal([...rows.values()].find(row => row.request?.id === 'old-R').delivered, true)
})

test('confirmed Helper stop does not lose overall restoration when native inspection fails before wake persistence', async t => {
  const { runtime, rows } = await runtimeFixture(t)
  const request = { id: 'helper-original', role: 'Helper', reason: 'helper', sources: [] }
  const record = { identity: { workId: runtime.roleKey('Helper'), executionId: 'stopped-before-wake', role: 'Helper' }, sessionId: 'helper-session', generation: 1, lastWake: request }
  await runtime.saveRole(record)
  let active = true, stops = 0, inspections = 0
  runtime.observations = { mayApply: async () => active }
  runtime.native = { stop: async () => { stops++; active = false; return { status: 'stopped' } } }
  t.mock.method(DshSessionReader.prototype, 'inspect', async () => {
    if (++inspections === 1) throw new Error('native inspection temporarily unavailable after confirmed stop')
    return { exists: true, lastTurn: { turn: 5, closed: true } } as any
  })
  const pending = { id: 'confirmed-stop-recovery', action: { kind: 'restore-helper', identity: record.identity, elapsedMs: 2400000 } }
  await runtime.enqueueObservation(pending)
  await assert.rejects(runtime.processObservations(), /temporarily unavailable/)
  assert.equal([...rows.values()].find(row => row.pending?.id === pending.id).complete, false)
  await runtime.processObservations()
  const wake = [...rows.values()].find(row => row.request?.id === 'overall-restore:' + pending.id)
  assert.equal(wake?.request.context.overallRestoration, true)
  assert.equal(stops, 1, 'a confirmed old execution does not require a second native stop')
  assert.equal([...rows.values()].find(row => row.pending?.id === pending.id).complete, true)
})

test('a consumed recovery input with an unacknowledged wake receipt does not hide a later real interruption', async t => {
  const { runtime, rows } = await runtimeFixture(t)
  const request = { id: 'previous-R', role: 'Helper', reason: 'startup-recovery', sources: [] }
  const record = { identity: { workId: runtime.roleKey('Helper'), executionId: 'current-helper', role: 'Helper' }, sessionId: 'helper-session', generation: 1,
    delivery: { request, messageId: 'native-R', text: 'previous recovery explanation', confirmed: true } }
  await runtime.wake(request, { targetExecutionId: record.identity.executionId })
  t.mock.method(DshSessionReader.prototype, 'inputs', async () => new Map([['native-R', { state: 'consumed', text: 'previous recovery explanation', source: 'deepseek-servant' }]]))
  const recovered = await runtime.arrangeNativeContinuation(record, { facts: 'new real interruption' }, { lastTurn: { turn: 9, closed: false } })
  assert.notEqual(recovered.id, request.id)
  assert.equal(recovered.context.interruptedTurn.turn, 9)
  assert.equal([...rows.values()].filter(row => row.request?.id === recovered.id).length, 1)
})

test('startup resumes an authorized overall stop intent across the crash-before-native-stop window', async t => {
  const { runtime, rows } = await runtimeFixture(t)
  const record = { identity: { workId: runtime.roleKey('Helper'), executionId: 'cold-overall', role: 'Helper' }, sessionId: 'cold-overall-session', generation: 1,
    lastWake: { id: 'deep-dive', role: 'Helper', reason: 'helper', sources: [] } }
  await runtime.saveRole(record)
  const pending = { id: 'persisted-overall', action: { kind: 'restore-helper', identity: record.identity, elapsedMs: 2400000 } }
  await runtime.enqueueObservation(pending)
  const stored = [...rows].find(([, row]) => row.pending?.id === pending.id)!
  rows.set(stored[0], { ...stored[1], stopStarted: true })
  runtime.observations = { mayApply: async () => false }
  runtime.native = { stop: async () => ({ status: 'superseded' }), get: () => undefined }
  let histories = 0
  t.mock.method(DshSessionReader.prototype, 'events', async () => { histories++; return [] })
  t.mock.method(DshSessionReader.prototype, 'inspect', async () => ({ exists: true, lifecycleKnown: true, lastTurn: { turn: 6, closed: true, reason: 'aborted', abortCause: 'disposed' }, unresolvedToolCallIds: [], queuedInbox: { nextTurn: [], nextStep: [] } }) as any)
  runtime.pump = async () => {}
  await runtime.startup()
  const continuations = [...rows.values()].filter(row => row.recovery)
  assert.equal(continuations.length, 1)
  assert.equal(continuations[0].request.id, 'overall-restore:' + pending.id)
  assert.equal(continuations[0].request.context.overallRestoration, true)
  assert.ok(histories > 0, 'empty live registry alone is not accepted as stop proof')
})
test('overall observation intent must persist before its native stop begins', async t => {
  const { runtime } = await runtimeFixture(t)
  const identity = { workId: runtime.roleKey('Helper'), executionId: 'not-yet-stopped', role: 'Helper' }
  await runtime.saveRole({ identity, sessionId: 'helper-session', generation: 1 })
  runtime.observations = { mayApply: async () => true }
  runtime.native = { stop: async () => { throw new Error('native stop must not run') } }
  const set = runtime.records.set.bind(runtime.records)
  runtime.records.set = async (key: string, value: unknown) => { if (key.includes('/observations/')) throw new Error('intent storage failed'); return set(key, value) }
  await assert.rejects(runtime.arrangeObservation({ id: 'unpersisted', action: { kind: 'restore-helper', identity, elapsedMs: 2400000 } }), /intent storage failed/)
})

test('a live Helper whose progress invalidated the queued stop is not forced through cold reconciliation', async t => {
  const { runtime, rows } = await runtimeFixture(t)
  const identity = { workId: runtime.roleKey('Helper'), executionId: 'live-progress', role: 'Helper' }
  await runtime.saveRole({ identity, sessionId: 'live-helper-session', generation: 1 })
  const pending = { id: 'stale-overall', action: { kind: 'restore-helper', identity, elapsedMs: 2400000 } }
  await runtime.enqueueObservation(pending)
  const saved = [...rows].find(([, row]) => row.pending?.id === pending.id)!
  rows.set(saved[0], { ...saved[1], stopStarted: true })
  runtime.observations = { mayApply: async () => false }
  runtime.native = { stop: async (_work: string, _execution: string, actual: unknown) => { assert.equal(actual, pending); return { status: 'superseded' } }, get: () => ({}) }
  t.mock.method(DshSessionReader.prototype, 'events', async () => { throw new Error('must not replace a current progress check with cold evidence') })
  await runtime.arrangeObservation(pending)
  assert.ok(![...rows.values()].some(row => row.request?.context?.overallRestoration))
})

for (const boundary of ['pending-producer', 'exact-user-stop', 'new-generation'] as const) test(`persisted overall restoration respects ${boundary}`, async t => {
  const { runtime, rows } = await runtimeFixture(t)
  const identity = { workId: runtime.roleKey('Helper'), executionId: 'old-overall', role: 'Helper' }
  const record: any = { identity, sessionId: 'helper-session', generation: 1, lastWake: { id: 'original', role: 'Helper', reason: 'helper', sources: [] },
    ...(boundary === 'pending-producer' ? { stopUnknown: { reason: 'native producer remains unconfirmed', jobs: ['pending-job'] } } : {}) }
  await runtime.saveRole(record)
  if (boundary === 'exact-user-stop') await runtime.controls.requestExecutionStop('stop-selected-helper', { workId: identity.workId, executionId: identity.executionId })
  if (boundary === 'new-generation') await runtime.saveRole({ ...record, identity: { ...identity, executionId: 'replacement' }, generation: 2 })
  const pending = { id: 'overall-' + boundary, action: { kind: 'restore-helper', identity, elapsedMs: 2400000 } }
  await runtime.enqueueObservation(pending)
  const saved = [...rows].find(([, row]) => row.pending?.id === pending.id)!
  rows.set(saved[0], { ...saved[1], stopStarted: true })
  runtime.observations = { mayApply: async () => false }
  runtime.native = { stop: async () => { assert.equal(boundary, 'pending-producer'); return { status: 'superseded' } }, get: () => undefined }
  t.mock.method(DshSessionReader.prototype, 'events', async () => [])
  if (boundary === 'pending-producer') await assert.rejects(runtime.processObservations(), /unconfirmed/)
  else await runtime.processObservations()
  assert.ok(![...rows.values()].some(row => row.request?.context?.overallRestoration))
  assert.equal(runtime.roleRecords.get(identity.workId).stopped, undefined)
  assert.equal([...rows.values()].find(row => row.pending?.id === pending.id).complete, boundary !== 'pending-producer')
})
test('one unresolved Helper stop does not starve another execution observation responsibility', async t => {
  const { runtime, rows } = await runtimeFixture(t)
  const identity = { workId: runtime.roleKey('Helper'), executionId: 'blocked-helper', role: 'Helper' }
  await runtime.saveRole({ identity, sessionId: 'helper-session', generation: 1 })
  runtime.observations = { mayApply: async () => true }
  runtime.native = { stop: async () => ({ status: 'unconfirmed', reason: 'producer did not confirm', jobs: ['job'] }) }
  const first = { id: 'blocked-stop', action: { kind: 'restore-helper', identity, elapsedMs: 2400000 } }
  const second = { id: 'other-worker', action: { kind: 'inspect-role', identity: { workId: 'other', executionId: 'other-worker-execution', role: 'Worker', taskId: 'T2', member: 'A' }, elapsedMs: 300000 } }
  await runtime.enqueueObservation(first); await runtime.enqueueObservation(second)
  await assert.rejects(runtime.processObservations(), /producer did not confirm/)
  assert.equal([...rows.values()].find(row => row.pending?.id === first.id).complete, false)
  assert.equal([...rows.values()].find(row => row.pending?.id === second.id).complete, true)
  assert.ok([...rows.values()].some(row => row.request?.context?.observation.identity.executionId === 'other-worker-execution'))
})

test('sealed in-flight stop does not block completion notifications or another task in later polls', async () => {
  const { runtime } = queue(), gate = Promise.withResolvers<void>(), calls: string[] = []
  runtime.roleRecords = new Map([['worker-T1', { identity: { workId: 'worker-T1', executionId: 'e1', role: 'Worker', taskId: 'T1' }, sessionId: 's1', generation: 1 }]])
  runtime.environment = { heartbeat: async () => undefined }; runtime.observations = { tick: async () => undefined }
  runtime.applyUserControls = runtime.processObservations = runtime.observeRecoveryMarkers = runtime.processHostRestores = runtime.processRestores = async () => undefined
  runtime.errorTail = Promise.resolve(); runtime.error = (error: unknown) => { throw error }
  runtime.stopOwnedRecord = async () => { calls.push('stop'); await gate.promise; return { status: 'stopped' } }
  runtime.pump = async () => { calls.push('Foreground/Recorder/T2') }
  await runtime.sealBusiness('T1')
  let settled = false
  const first = runtime.observe().then(() => { settled = true })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, true, 'a pending stop must not hold the discovery/notification poll')
    await runtime.observe()
    assert.deepEqual(calls, ['stop', 'Foreground/Recorder/T2', 'Foreground/Recorder/T2'])
  } finally { gate.resolve(); await first }
})

test('tracked stop does not reuse old generation proof or discard an older pending promise', async () => {
  const { runtime } = queue(), gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()], called: string[] = []
  const first = { identity: {workId:'w', executionId:'e1', role:'Worker', taskId:'T'}, sessionId:'s1', generation:1 }
  const second = { ...first, identity:{...first.identity,executionId:'e2'},sessionId:'s2',generation:2 }
  runtime.roleRecords = new Map([['w',first]]); runtime.error = (error: unknown) => { throw error }
  runtime.stopOwnedRecord = async (record: any) => { called.push(record.identity.executionId); await gates[record.generation-1].promise; return {status:'stopped'} }
  assert.equal(runtime.trackedStop(first),false)
  runtime.roleRecords.set('w',second)
  assert.equal(runtime.trackedStop(second),false)
  assert.equal(runtime.stopOperations.size,2)
  gates[0].resolve(); await [...runtime.stopOperations.values()][0].promise
  assert.equal(runtime.roleRecords.get('w').stopped,undefined,'old completion cannot mark a newer execution stopped')
  assert.equal(runtime.trackedStop(second),false)
  gates[1].resolve(); await Promise.all([...runtime.stopOperations.values()].map((stop:any)=>stop.promise))
  assert.equal(runtime.trackedStop(runtime.roleRecords.get('w')),true)
  assert.deepEqual(called,['e1','e2'])
})

test('unconfirmed tracked stop preserves evidence and rechecks the same actual execution', async () => {
  const { runtime } = queue(), errors: unknown[] = []
  const record = {identity:{workId:'w',executionId:'e',role:'Worker',taskId:'T'},sessionId:'s',generation:1}
  runtime.roleRecords = new Map([['w',record]]); runtime.error=(error:unknown)=>errors.push(error)
  let calls=0; runtime.stopOwnedRecord=async()=>++calls===1?{status:'unconfirmed',reason:'producer has not reported',jobs:['j']}:{status:'stopped'}
  assert.equal(runtime.businessStopped('T'),false)
  await Promise.all([...runtime.stopOperations.values()].map((stop:any)=>stop.promise))
  assert.equal(runtime.roleRecords.get('w').stopped,undefined)
  assert.deepEqual(runtime.roleRecords.get('w').stopUnknown.jobs,['j'])
  assert.equal(runtime.businessStopped('T'),false)
  await Promise.all([...runtime.stopOperations.values()].map((stop:any)=>stop.promise))
  assert.equal(runtime.businessStopped('T'),true);assert.equal(calls,2);assert.equal(errors.length,1)
})

test('pending producer prevents only its Task cleanup, not another Task cleanup', async t => {
  const {runtime,files}=await runtimeFixture(t), gate=Promise.withResolvers<void>(), cleaned:string[]=[]
  const one={version:1,taskId:'11111111-1111-4111-8111-111111111111',owner:'A',route:'P',status:'complete',sourcePath:'tasks/one_P.md'}
  const two={...one,taskId:'22222222-2222-4222-8222-222222222222',sourcePath:'tasks/two_P.md'}
  await withSnapshot(files,snapshot=>files.commit(snapshot,[one,two].map(task=>({path:paths.state('A',task.taskId)+'/Cleaner',content:''})),'clean requests'))
  const record={identity:{workId:'w',executionId:'e',role:'Worker',taskId:one.taskId},sessionId:'s',generation:1}
  runtime.roleRecords.set('w',record);runtime.stopOwnedRecord=async()=>{await gate.promise;return{status:'stopped'}}
  runtime.cleaner={clean:async(task:any)=>{cleaned.push(task.taskId);return{status:'released'}}}
  const clean=(task:any)=>withSnapshot(files,snapshot=>runtime.clean(task,snapshot))
  try{assert.equal(await clean(one),false);assert.equal(await clean(two),true);assert.deepEqual(cleaned,[two.taskId])}
  finally{gate.resolve();await Promise.all([...runtime.stopOperations.values()].map((stop:any)=>stop.promise))}
  assert.equal(await clean(one),true);assert.deepEqual(cleaned,[two.taskId,one.taskId])
})

test('dispose joins stops installed by already-owned stopping work before disposing observation storage', async () => {
  const {runtime}=queue(), first=Promise.withResolvers<void>(),second=Promise.withResolvers<void>(),events:string[]=[]
  const a={identity:{workId:'a',executionId:'e1',role:'Worker',taskId:'T'},sessionId:'a',generation:1}
  const b={identity:{workId:'b',executionId:'e2',role:'Worker',taskId:'T'},sessionId:'b',generation:1}
  runtime.roleRecords=new Map([['a',a],['b',b]]);runtime.loop={stop:async()=>events.push('loop-stopped')};runtime.observations={dispose:async()=>events.push('observations-disposed')};runtime.error=(error:unknown)=>{throw error}
  runtime.stopOwnedRecord=async(record:any)=>{if(record.identity.workId==='a'){await first.promise;runtime.trackedStop(b)}else await second.promise;return{status:'stopped'}}
  runtime.trackedStop(a);const disposed=runtime.dispose();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(events,['loop-stopped'])
  first.resolve();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(events,['loop-stopped'])
  second.resolve();await disposed;assert.deepEqual(events,['loop-stopped','observations-disposed'])
})

test('native stop success without durable role save is not cached as cleanup proof', async () => {
  const {runtime}=queue(),errors:unknown[]=[]
  const record={identity:{workId:'w',executionId:'e',role:'Worker',taskId:'T'},sessionId:'s',generation:1}
  runtime.roleRecords=new Map([['w',record]]);runtime.error=(error:unknown)=>errors.push(error)
  runtime.stopOwnedRecord=async()=>({status:'stopped'})
  runtime.saveRole=async()=>{throw new Error('durable role write failed')}
  assert.equal(runtime.businessStopped('T'),false)
  await Promise.all([...runtime.stopOperations.values()].map((stop:any)=>stop.promise))
  assert.equal([...runtime.stopOperations.values()][0].result,undefined)
  assert.equal(runtime.roleRecords.get('w').stopped,undefined)
  assert.equal(errors.length,1)
  assert.equal(runtime.businessStopped('T'),false)
  await Promise.all([...runtime.stopOperations.values()].map((stop:any)=>stop.promise))
})

test('replacement record cannot erase a tracked older producer that remains unconfirmed', async () => {
  const {runtime}=queue()
  const record={identity:{workId:'w',executionId:'e1',role:'Worker',taskId:'T'},sessionId:'s1',generation:1}
  runtime.roleRecords=new Map([['w',record]]);runtime.error=()=>undefined
  runtime.stopOwnedRecord=async()=>({status:'unconfirmed',reason:'old producer not confirmed',jobs:['j1']})
  assert.equal(runtime.businessStopped('T'),false)
  await Promise.all([...runtime.stopOperations.values()].map((stop:any)=>stop.promise))
  // Even an incorrectly substituted newer record is not proof about the old job.
  runtime.roleRecords.set('w',{...record,identity:{...record.identity,executionId:'e2'},sessionId:'s2',generation:2,stopped:true})
  assert.equal(runtime.businessStopped('T'),false)
  assert.equal([...runtime.stopOperations.values()][0].result.status,'unconfirmed')
})

test('unchanged unconfirmed execution stop reports one diagnostic until its actual evidence changes', async () => {
  const {runtime}=queue(),errors:unknown[]=[]
  const record={identity:{workId:'w',executionId:'e',role:'Worker',taskId:'T'},sessionId:'s',generation:1}
  runtime.roleRecords=new Map([['w',record]]);runtime.error=(error:unknown)=>errors.push(error)
  let jobs=['j'];runtime.stopOwnedRecord=async()=>({status:'unconfirmed',reason:'still waiting for producer',jobs})
  for(let i=0;i<3;i++){runtime.businessStopped('T');await Promise.all([...runtime.stopOperations.values()].map((stop:any)=>stop.promise))}
  assert.equal(errors.length,1,'unchanged evidence is one existing diagnostic responsibility')
  jobs=['j','new-observed-producer'];runtime.businessStopped('T');await Promise.all([...runtime.stopOperations.values()].map((stop:any)=>stop.promise))
  assert.equal(errors.length,2,'new producer evidence is an actual change, not a retry count')
})

test('late superseded stop uses exact already-persisted old execution confirmation after replacement', async () => {
  const {runtime}=queue(),gate=Promise.withResolvers<void>()
  const old={identity:{workId:'w',executionId:'e1',role:'Worker',taskId:'T'},sessionId:'s',generation:1}
  runtime.roleRecords=new Map([['w',old]]);runtime.error=()=>undefined
  runtime.stopOwnedRecord=async()=>{await gate.promise;return{status:'superseded'}}
  runtime.businessStopped('T')
  await runtime.saveRole({...old,stopped:true})
  await runtime.saveRole({...old,identity:{...old.identity,executionId:'e2'},generation:2,stopped:true})
  gate.resolve();await Promise.all([...runtime.stopOperations.values()].map((stop:any)=>stop.promise))
  assert.equal(runtime.businessStopped('T'),true,'the durable e1 confirmation must survive a late superseded result')
})

test('durable exact stop confirmation arriving after superseded settlement unblocks cleanup', async () => {
  const {runtime}=queue()
  const old={identity:{workId:'w',executionId:'e1',role:'Worker',taskId:'T'},sessionId:'s',generation:1}
  runtime.roleRecords=new Map([['w',old]]);runtime.error=()=>undefined
  runtime.stopOwnedRecord=async()=>({status:'superseded'})
  runtime.businessStopped('T');await Promise.all([...runtime.stopOperations.values()].map((stop:any)=>stop.promise))
  assert.equal([...runtime.stopOperations.values()][0].result.status,'superseded')
  await runtime.saveRole({...old,stopped:true})
  await runtime.saveRole({...old,identity:{...old.identity,executionId:'e2'},generation:2,stopped:true})
  assert.equal(runtime.businessStopped('T'),true)
})

test('runtime shutdown drains admitted Host and Helper diagnostics before service storage closes', async () => {
  const { DshStorageAdapter } = await import('../src/adapters/dsh/storage.js')
  const { FrameworkService } = await import('../src/framework/service.js')
  const { disposeResources } = await import('../src/framework/dispose-resources.js')
  const { runtime, rows } = queue(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const events: string[] = [], reported: unknown[] = [], owner = { chain: Promise.resolve() }
  let closed = false, block = true
  const serial = <T>(run: () => Promise<T>): Promise<T> => (DshStorageAdapter.prototype as any).serial.call(owner, run)
  const guard = () => assert.equal(closed, false, 'admitted diagnostic cannot access closed storage')
  runtime.records = {
    get: (key: string) => serial(async () => { guard(); return structuredClone(rows.get(key)) }),
    set: (key: string, value: unknown) => serial(async () => { guard(); rows.set(key, structuredClone(value)); events.push('diagnostic-saved') }),
    list: (prefix: string) => serial(async () => { guard(); if (block) { block = false; entered.resolve(); await release.promise }
      return [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) }),
  }
  runtime.roleRecords = new Map(); runtime.errorTail = Promise.resolve(); runtime.closed = false
  runtime.environment = { error: (error: unknown) => reported.push(error) }
  runtime.loop = { stop: async () => { events.push('loop-stopped') } }
  runtime.observations = { dispose: async () => { events.push('observations-disposed') } }
  runtime.error(new Error('accepted Host fault'), { role: 'Worker' })
  runtime.error(new Error('accepted Helper fault'), { role: 'Helper' })
  await entered.promise
  const service = Object.create(FrameworkService.prototype) as any
  Object.assign(service, { closed: false, configuration: Promise.resolve(), configurationOwners: new Set(), accessTransitions: new Map(), opening: new Map(), stopping: new WeakMap(), accessOpening: new Map(), backgroundOpening: new Map(), accesses: new Map(), listeners: new Set(), disposalErrors: [],
    running: new Map([['local', { runtime, connection: { close: async () => { events.push('connection-closed') } } }]]) })
  const shutdown = disposeResources([() => service.dispose(), () => serial(async () => { closed = true; events.push('storage-closed') })])
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(events.includes('connection-closed'), false, 'service owns accepted diagnostic work until persisted')
  } finally { release.resolve(); await shutdown; await runtime.errorTail }
  assert.equal([...rows.values()].filter(row => row.request?.role === 'Helper').length, 1)
  assert.equal([...rows.keys()].filter(key => key.includes('/helper-errors/')).length, 1)
  assert.equal(reported.length, 2, 'Helper error is retained without recursively waking Helper')
  assert.ok(events.lastIndexOf('diagnostic-saved') < events.indexOf('connection-closed'))
  assert.ok(events.indexOf('connection-closed') < events.indexOf('storage-closed'))
  runtime.error(new Error('after close'), { role: 'Worker' }); await runtime.errorTail
  assert.equal(rows.size, 2, 'errors arriving after close do not create new persistence work')
})

test('a native disposal failure does not abandon previously admitted diagnostic persistence', async () => {
  const { runtime } = queue(), gate = Promise.withResolvers<void>(), failure = new Error('observation disposal failed')
  let persisted = false, settled = false
  runtime.roleRecords = new Map(); runtime.loop = { stop: async () => undefined }
  runtime.observations = { dispose: async () => { throw failure } }
  runtime.errorTail = gate.promise.then(() => { persisted = true })
  const disposal = runtime.dispose().finally(() => { settled = true })
  const rejected = assert.rejects(disposal, (error: unknown) => error === failure)
  try { await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false) }
  finally { gate.resolve(); await rejected }
  assert.equal(persisted, true)
})

test('runtime disposal preserves both shutdown and diagnostic drain failures', async () => {
  const { runtime } = queue(), stopFailure = new Error('native stop failed'), diagnosticFailure = new Error('diagnostic persistence failed')
  runtime.roleRecords = new Map(); runtime.loop = { stop: async () => { throw stopFailure } }
  runtime.observations = { dispose: async () => {} }
  runtime.errorTail = Promise.resolve().then(() => { throw diagnosticFailure })
  await assert.rejects(runtime.dispose(), (error: unknown) => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [stopFailure, diagnosticFailure])
    return true
  })
})

test('Helper exact restore preserves pending stop responsibility without blocking another restore command', async t => {
  const {runtime,storage}=await runtimeFixture(t),gate=Promise.withResolvers<void>(),stops:string[]=[],arranged:string[]=[]
  const one={identity:{workId:'one',executionId:'e1',role:'Recorder',taskId:'T1'},sessionId:'s1',generation:1}
  const two={identity:{workId:'two',executionId:'e2',role:'Recorder',taskId:'T2'},sessionId:'s2',generation:1}
  runtime.roleRecords.set('one',one);runtime.roleRecords.set('two',two)
  runtime.stopOwnedRecord=async(record:any)=>{stops.push(record.identity.executionId);if(record.identity.executionId==='e1')await gate.promise;return{status:'stopped'}}
  runtime.arrangeNativeContinuation=async(record:any,_input:any,_inspection:any,id:string)=>{arranged.push(record.identity.executionId+':'+id)}
  for(const [commandId,record] of [['one',one],['two',two]] as const)await storage.set(runtime.prefix+'restores/'+commandId,{commandId,createdAt:'2026-11-01T00:00:00Z',input:{target:record.identity,facts:'retained facts',hypotheses:'unknown',actionsTaken:'preserved',continuation:'continue'},complete:false})
  let returned=false;const first=runtime.processRestores().then(()=>{returned=true})
  try{
    await new Promise(resolve=>setImmediate(resolve))
    assert.equal(returned,true,'the first unresolved stop must not block processing the next command')
    await runtime.processRestores();await runtime.processRestores()
    assert.deepEqual(stops,['e1','e2']);assert.deepEqual(arranged,['e2:restore-role:two'])
    assert.equal((await storage.get<any>(runtime.prefix+'restores/one')).complete,false)
    assert.equal((await storage.get<any>(runtime.prefix+'restores/two')).complete,true)
  }finally{gate.resolve();await first;await Promise.all([...(runtime.stopOperations?.values()??[])].map((stop:any)=>stop.promise))}
  await runtime.processRestores();assert.deepEqual(arranged.sort(),['e1:restore-role:one','e2:restore-role:two'])
})

test('Helper restore skips busy work without taking its lock or losing the original command',async t=>{
  const {runtime,storage}=await runtimeFixture(t),record={identity:{workId:'w',executionId:'e',role:'Recorder',taskId:'T'},sessionId:'s',generation:1}
  runtime.roleRecords.set('w',record);runtime.workOperations=new Map([['w',new Promise(()=>{})]])
  let stops=0,arranged=0;runtime.stopOwnedRecord=async()=>{stops++;return{status:'stopped'}};runtime.arrangeNativeContinuation=async()=>{arranged++}
  const key=runtime.prefix+'restores/c';await storage.set(key,{commandId:'c',createdAt:'2026-11-01T00:00:00Z',input:{target:record.identity,facts:'facts'},complete:false})
  await runtime.processRestores();assert.equal(stops,0);assert.equal((await storage.get<any>(key)).complete,false)
  runtime.workOperations.delete('w');await runtime.processRestores();await Promise.all([...runtime.stopOperations.values()].map((stop:any)=>stop.promise));await runtime.processRestores()
  assert.equal(stops,1);assert.equal(arranged,1);assert.equal((await storage.get<any>(key)).complete,true)
})

test('Helper restore rechecks exact execution after its durable debug write before requesting stop',async t=>{
  const {runtime,storage}=await runtimeFixture(t),record={identity:{workId:'w',executionId:'old',role:'Recorder',taskId:'T'},sessionId:'s',generation:1}
  runtime.roleRecords.set('w',record);let stops=0;runtime.stopOwnedRecord=async()=>{stops++;return{status:'stopped'}}
  const original=runtime.transactions.run.bind(runtime.transactions)
  runtime.transactions.run=async(...args:any[])=>{const result=await original(...args);if(args[0]==='restore-debug:c')await runtime.saveRole({...record,identity:{...record.identity,executionId:'new'},generation:2});return result}
  const key=runtime.prefix+'restores/c';await storage.set(key,{commandId:'c',createdAt:'2026-11-01T00:00:00Z',input:{target:record.identity,facts:'facts'},complete:false})
  await runtime.processRestores();assert.equal(stops,0);assert.equal(runtime.roleRecords.get('w').identity.executionId,'new');assert.equal(runtime.roleRecords.get('w').stopped,undefined)
  await runtime.processRestores();assert.equal((await storage.get<any>(key)).complete,true);assert.equal(stops,0)
})

test('Helper overall restoration durably owns exact targets and does not wait for one producer before another target',async t=>{
  const {runtime,storage}=await runtimeFixture(t),gate=Promise.withResolvers<void>(),arranged:string[]=[]
  const one={identity:{workId:'one',executionId:'e1',role:'Recorder',taskId:'T1'},sessionId:'s1',generation:1,stopUnknown:{reason:'pending producer',jobs:['j1']}}
  const two={identity:{workId:'two',executionId:'e2',role:'Recorder',taskId:'T2'},sessionId:'s2',generation:1,stopUnknown:{reason:'pending producer',jobs:['j2']}}
  runtime.roleRecords.set('one',one);runtime.roleRecords.set('two',two)
  const key=runtime.prefix+'host-restores/overall';await storage.set(key,{commandId:'overall',createdAt:'2026-11-01T00:00:00Z',input:{facts:'preserved',hypotheses:'unknown',actionsTaken:'saved',continuation:'inspect'},complete:false})
  runtime.stopOwnedRecord=async(record:any)=>{assert.equal((await storage.get<any>(key)).targets.length,2,'target ownership must persist before stopping');if(record.identity.executionId==='e1')await gate.promise;return{status:'stopped'}}
  runtime.arrangeNativeContinuation=async(record:any)=>{arranged.push(record.identity.executionId)}
  let returned=false;const first=runtime.processHostRestores().then(()=>{returned=true})
  try{await new Promise(resolve=>setImmediate(resolve));assert.equal(returned,true);await runtime.processHostRestores();assert.deepEqual(arranged,['e2']);assert.equal((await storage.get<any>(key)).complete,false)}
  finally{gate.resolve();await first;await Promise.all([...(runtime.stopOperations?.values()??[])].map((stop:any)=>stop.promise))}
  await runtime.processHostRestores();assert.deepEqual(arranged.sort(),['e1','e2']);assert.equal((await storage.get<any>(key)).complete,true)
})

for(const point of ['after-stop','after-arrange','after-target-receipt'] as const)test('overall restore resumes exact target across crash '+point,async t=>{
  const {runtime,storage,files,rows}=await runtimeFixture(t),workId=runtime.roleKey('Recorder','T'),key=runtime.prefix+'host-restores/crash'
  const record={identity:{workId,executionId:'old',role:'Recorder',taskId:'T'},sessionId:'s',generation:1,stopUnknown:{reason:'old producer',jobs:['j']},lastWake:{id:'original',role:'Recorder',taskId:'T',reason:'business-complete',sources:[]}}
  await runtime.saveRole(record);let stops=0;runtime.stopOwnedRecord=async()=>{stops++;return{status:'stopped'}}
  await storage.set(key,{commandId:'crash',createdAt:'2026-11-01T00:00:00Z',input:{facts:'saved',hypotheses:'unknown',actionsTaken:'saved',continuation:'inspect'},complete:false})
  await runtime.processHostRestores();await Promise.all([...runtime.stopOperations.values()].map((stop:any)=>stop.promise))
  const set=storage.set.bind(storage)
  if(point!=='after-stop'){
    let fail=true;storage.set=async(k:string,value:any)=>{if(fail&&k===key&&(point==='after-arrange'?value.targets?.[0]?.complete&&!value.complete:value.complete)){fail=false;throw Error('simulated crash boundary')}return set(k,value)}
    await assert.rejects(runtime.processHostRestores(),/simulated crash boundary/);storage.set=set
  }
  const restarted=new FrameworkRoleRuntime(runtime.ctx,files,storage,runtime.config,runtime.environment) as any
  for(const row of await storage.list<any>(runtime.prefix+'roles/'))restarted.roleRecords.set(row.value.identity.workId,row.value)
  restarted.stopOwnedRecord=async()=>{throw Error('confirmed old execution must not be killed again')}
  await restarted.saveRole({identity:{workId:'new-task',executionId:'new',role:'Worker',taskId:'T-new'},sessionId:'new-session',generation:1,stopUnknown:{reason:'new fault',jobs:['new-job']}})
  await restarted.processHostRestores()
  const saved=await storage.get<any>(key);assert.equal(saved.complete,true);assert.equal(saved.targets.length,1);assert.equal(saved.targets[0].outcome,'arranged');assert.equal(stops,1)
  assert.equal([...rows.values()].filter(row=>row.request?.id==='host-restored:crash:old').length,1)
})

for(const disposition of ['user-stop','new-generation'] as const)test('overall fixed target respects '+disposition+' instead of reviving old input',async t=>{
  const {runtime,storage}=await runtimeFixture(t),workId=runtime.roleKey('Recorder','T'),key=runtime.prefix+'host-restores/control'
  const record={identity:{workId,executionId:'old',role:'Recorder',taskId:'T'},sessionId:'s',generation:1,stopUnknown:{reason:'producer',jobs:['j']},lastWake:{id:'original',role:'Recorder',taskId:'T',reason:'business-complete',sources:[]}}
  await runtime.saveRole(record);runtime.stopOwnedRecord=async()=>({status:'stopped'})
  await storage.set(key,{commandId:'control',createdAt:'2026-11-01T00:00:00Z',input:{facts:'saved'},complete:false})
  await runtime.processHostRestores();await Promise.all([...runtime.stopOperations.values()].map((stop:any)=>stop.promise))
  if(disposition==='user-stop')await runtime.controls.requestExecutionStop('user',{workId,executionId:'old',taskId:'T'})
  else await runtime.saveRole({...record,identity:{...record.identity,executionId:'new'},generation:2,stopUnknown:undefined})
  let resumed=0;runtime.arrangeNativeContinuation=async()=>{resumed++}
  await runtime.processHostRestores();const saved=await storage.get<any>(key)
  assert.equal(saved.complete,true);assert.equal(resumed,0);assert.equal(saved.targets[0].outcome,disposition==='user-stop'?'user-stopped':'superseded')
})

test('tick user controls do not await an owned producer but the explicit control caller still waits for real settlement',async t=>{
  const {runtime}=await runtimeFixture(t),gate=Promise.withResolvers<void>(),record={identity:{workId:'w',executionId:'e',role:'Worker',taskId:'T'},sessionId:'s',generation:1}
  runtime.roleRecords.set('w',record);let stops=0;runtime.stopOwnedRecord=async()=>{stops++;await gate.promise;return{status:'stopped'}}
  await runtime.controls.setTask('pause','T','paused')
  let tickReturned=false,userReturned=false
  const tick=runtime.applyUserControls(false).then(()=>{tickReturned=true})
  try{await new Promise(resolve=>setImmediate(resolve));assert.equal(tickReturned,true);const user=runtime.applyUserControls().then(()=>{userReturned=true});await new Promise(resolve=>setImmediate(resolve));assert.equal(userReturned,false);assert.equal(stops,1);gate.resolve();await user;assert.equal(runtime.roleRecords.get('w').stopped,true)}finally{gate.resolve();await tick}
})

test('explicit Task and execution control waits exclude another Task pending producer',async t=>{
  const {runtime}=await runtimeFixture(t),gate=Promise.withResolvers<void>(),stops:string[]=[]
  for(const task of ['A','B'])runtime.roleRecords.set(task,{identity:{workId:task,executionId:task,role:'Worker',taskId:task},sessionId:task,generation:1})
  runtime.stopOwnedRecord=async(record:any)=>{stops.push(record.identity.workId);if(record.identity.workId==='A')await gate.promise;return{status:'stopped'}}
  await runtime.controls.setTask('pause-A','A','paused');await runtime.applyUserControls(false)
  await runtime.controls.setTask('pause-B','B','paused')
  try{
    let done=false;const own=runtime.applyUserControls(true,{taskId:'B'}).then(()=>{done=true})
    await new Promise(resolve=>setImmediate(resolve));assert.equal(done,true);await own
    assert.equal(runtime.roleRecords.get('A').stopped,undefined);assert.equal(runtime.roleRecords.get('B').stopped,true)
    await runtime.requestExecutionStop('exact-B','B','B');assert.equal((await runtime.controls.execution('B')).result.state,'stopped')
    assert.deepEqual(stops.sort(),['A','B'])
  }finally{gate.resolve();await Promise.all([...runtime.stopOperations.values()].map((stop:any)=>stop.promise))}
})

test('exact stop stays pending during producer wait and records actual unconfirmed outcome rather than stopped',async t=>{
  const {runtime}=await runtimeFixture(t),gate=Promise.withResolvers<void>(),record={identity:{workId:'w',executionId:'e',role:'Worker',taskId:'T'},sessionId:'s',generation:1}
  runtime.roleRecords.set('w',record);runtime.error=()=>undefined;runtime.stopOwnedRecord=async()=>{await gate.promise;return{status:'unconfirmed',reason:'producer incomplete',jobs:['j']}}
  const user=runtime.requestExecutionStop('c','w','e');await new Promise(resolve=>setImmediate(resolve))
  assert.equal((await runtime.controls.execution('e')).result,undefined);assert.equal(runtime.roleRecords.get('w').stopped,undefined)
  await runtime.applyUserControls(false);gate.resolve();await user
  assert.equal((await runtime.controls.execution('e')).result.state,'unconfirmed');assert.equal(runtime.roleRecords.get('w').stopped,undefined)
})

test('owned stop prevents idle Organizer new admission before stop-intent persistence without blocking another work',async t=>{
  const {runtime}=await runtimeFixture(t),gate=Promise.withResolvers<void>(),sent:string[]=[]
  const key=runtime.roleKey('Organizer'),record={identity:{workId:key,executionId:'old',role:'Organizer'},sessionId:'s',generation:1,lastWake:{taskId:'A'}}
  runtime.roleRecords.set(key,record);runtime.active=()=>false;runtime.gateway={exists:async()=>false};runtime.native={get:()=>undefined,open:async()=>({send:async(text:string)=>sent.push(JSON.parse(text).taskId)})}
  runtime.stopOwnedRecord=async()=>{await gate.promise;return{status:'stopped'}};runtime.trackedStop(record)
  await runtime.wake({id:'new-B',role:'Organizer',taskId:'B',reason:'user-resume',sources:[]});await runtime.wake({id:'free-C',role:'Worker',taskId:'C',workerId:'c',reason:'user-resume',sources:[]})
  try{await runtime.runQueue();assert.deepEqual(sent,['C']);assert.equal(runtime.roleRecords.get(key).identity.executionId,'old')}
  finally{gate.resolve();await Promise.all([...runtime.stopOperations.values()].map((stop:any)=>stop.promise))}
  await runtime.runQueue();assert.deepEqual(sent,['C','B']);assert.notEqual(runtime.roleRecords.get(key).identity.executionId,'old')
})

test('tick exact stop is not starved by its own same-pass Task hold inspection',async t=>{
  const {runtime}=await runtimeFixture(t),record={identity:{workId:'w',executionId:'e',role:'Worker',taskId:'T'},sessionId:'s',generation:1}
  runtime.roleRecords.set('w',record);let stops=0;runtime.stopOwnedRecord=async()=>{stops++;return{status:'stopped'}}
  await runtime.controls.requestExecutionStop('saved-before-crash',{workId:'w',executionId:'e',taskId:'T'})
  await runtime.applyUserControls(false);await new Promise(resolve=>setImmediate(resolve));await runtime.applyUserControls(false)
  assert.equal(stops,1);assert.equal((await runtime.controls.execution('e')).result.state,'stopped')
})

test('a new explicit stop command rechecks a prior unconfirmed execution while same-command replay retains its result',async t=>{
  const {runtime}=await runtimeFixture(t),record={identity:{workId:'w',executionId:'e',role:'Worker',taskId:'T'},sessionId:'s',generation:1}
  runtime.roleRecords.set('w',record);runtime.error=()=>undefined;let calls=0
  runtime.stopOwnedRecord=async()=>++calls===1?{status:'unconfirmed',reason:'producer pending',jobs:['j']}:{status:'stopped'}
  await runtime.requestExecutionStop('first','w','e');assert.equal((await runtime.controls.execution('e')).result.state,'unconfirmed')
  await runtime.requestExecutionStop('first','w','e');assert.equal(calls,1,'the completed original command remains an idempotent receipt')
  await runtime.requestExecutionStop('second','w','e');assert.equal(calls,2,'new explicit intent must inspect later producer evidence')
  assert.equal((await runtime.controls.execution('e')).result.state,'stopped');assert.equal(runtime.roleRecords.get('w').stopped,true)
})

test('one server rate-limit fact does not reassign Helper after its diagnostic was delivered', async () => {
  const { GitHubError } = await import('../src/experimental/private-git/github.js')
  const { runtime, rows } = queue(), fact = {}, reported: unknown[] = []
  runtime.closed = false; runtime.errorTail = Promise.resolve(); runtime.environment = { error: (error: unknown) => reported.push(error) }
  const limit = (identity: object) => new GitHubError(429, 'same server limit', 120, 120000, identity)
  const deliver = () => { for (const [key, row] of rows) if (row.request) rows.set(key, { ...row, delivered: true }) }
  runtime.error(limit(fact)); await runtime.errorTail; deliver()
  runtime.error(limit(fact)); await runtime.errorTail
  assert.equal([...rows.values()].filter(row => row.request).length, 1)
  runtime.error(limit({})); await runtime.errorTail; deliver()
  assert.equal([...rows.values()].filter(row => row.request).length, 2, 'a new upstream limit response is a new fact')
  runtime.error(new Error('unrelated failure')); await runtime.errorTail; deliver()
  runtime.error(new Error('unrelated failure')); await runtime.errorTail
  assert.equal([...rows.values()].filter(row => row.request).length, 4, 'ordinary later errors retain their existing event semantics')
  assert.equal(reported.length, 5, 'UI still receives each actual error observation')
})

test('failed diagnostic persistence does not permanently suppress the same server limit fact', async () => {
  const { GitHubError } = await import('../src/experimental/private-git/github.js')
  const { runtime, rows } = queue(), fact = {}, set = runtime.records.set
  runtime.closed = false; runtime.errorTail = Promise.resolve(); runtime.environment = { error: () => undefined }
  let fail = true
  runtime.records.set = async (...args: unknown[]) => { if (fail) { fail = false; throw new Error('diagnostic storage unavailable') }; return set(...args) }
  const error = new GitHubError(429, 'server limit', 120, 120000, fact)
  runtime.error(error); await runtime.errorTail; assert.equal(rows.size, 0)
  runtime.error(error); runtime.error(error); await runtime.errorTail
  assert.equal([...rows.values()].filter(row => row.request).length, 1)
})


test('marker discovery uses the supplied view and does not acquire per-Task snapshots for absent markers', async t => {
  const { runtime, files } = await runtimeFixture(t)
  runtime.taskMetadata = async () => Array.from({ length: 3 }, (_, i) => ({ taskId: 'no-marker-' + i, status: 'running' }))
  const snapshot = files.snapshot.bind(files)
  let reads = 0
  files.snapshot = async () => { reads++; return snapshot() }
  await withSnapshot(files, current => runtime.observeRecoveryMarkers(current))
  assert.equal(reads, 1)
})

test('whole runtime poll shares one post-maintenance view for roster, tasks and absent recovery markers', async t => {
  const { runtime, files, storage, errors } = await runtimeFixture(t)
  const { InstanceRegistration } = await import('../src/framework/instances.js')
  const registration = new InstanceRegistration(files, runtime.transactions, storage, {repositoryId:'local',repositoryOwner:'A',login:'A',instanceUUID:'00000000-0000-4000-8000-000000000001',workerSeats:2})
  await registration.register()
  await withSnapshot(files, snapshot => files.commit(snapshot, Array.from({length:3}, (_,i) => ({path:paths.task('running-'+i),content:encodeJson({version:1,taskId:'running-'+i,route:'P',owner:'A',sourcePath:'tasks/source'+i+'_P.md',status:'running'})})), 'existing tasks'))
  let acquisitions = 0, resources = 0
  const snapshot = files.snapshot.bind(files)
  files.snapshot = async () => { acquisitions++; return snapshot() }
  runtime.environment.observeResources = async (current: any) => { resources++; assert.equal((await registration.observe(current)).length,1) }
  await runtime.loop.poll()
  assert.equal(acquisitions, 1)
  assert.equal(resources,1)
  assert.deepEqual(errors,[])
})

test('a marker appearing after the fixed view is discovered next poll rather than guessed into the old view', async t => {
  const {runtime, files, rows} = await runtimeFixture(t)
  const taskId='new-marker', marker=paths.state('A',taskId)+'/recovery'
  runtime.taskMetadata = async () => [{taskId,status:'running'}]
  await withSnapshot(files, async old => {
    await withSnapshot(files, fresh => files.commit(fresh,[{path:marker,content:''}],'new actual marker'))
    await runtime.observeRecoveryMarkers(old)
    assert.equal(rows.get(runtime.watchKey(taskId,'A')),undefined)
  })
  await runtime.observeRecoveryMarkers()
  assert.ok(rows.get(runtime.watchKey(taskId,'A'))?.watch)
})

test('Organizer notification enumeration uses exact marker metadata without fetching empty bodies', async t => {
  const {runtime,files}=await runtimeFixture(t),taskId='completion-metadata'
  const complete=paths.state('B',taskId)+'/complete'
  await withSnapshot(files,snapshot=>files.commit(snapshot,[{path:paths.task(taskId),content:encodeJson({version:1,taskId,route:'O',owner:'A',sourcePath:'tasks/c_O.md',status:'running',members:['A','B']})},{path:complete,content:''}],'completed member'))
  const read=files.read.bind(files);let bodyReads=0
  files.read=async(snapshot,path)=>{if(path.endsWith('/complete'))bodyReads++;return read(snapshot,path)}
  await withSnapshot(files,async snapshot=>assert.deepEqual(await runtime.notifications(snapshot,{role:'Organizer',workId:'o',executionId:'e',owner:'A'},taskId),[complete]))
  assert.equal(bodyReads,0)
})

test('busy native work retains its queued notification without acquiring a remote admission view', async t => {
  const {runtime,files,rows}=await runtimeFixture(t)
  const request={id:'busy-signal',role:'Planner',taskId:'T',reason:'notification',sources:[{path:paths.state('A','T')+'/Planner_Inbox',version:'v'}]}
  await withSnapshot(files,snapshot=>files.commit(snapshot,[{path:request.sources[0]!.path,content:''}],'pending notification'))
  const workId=runtime.requestKey(request)
  runtime.roleRecords.set(workId,{identity:{workId,executionId:'busy',role:'Planner',taskId:'T',member:'A'},sessionId:'busy-session',generation:1})
  runtime.native={get:()=>({observe:()=>({state:'running'})})}
  let snapshots=0
  const snapshot=files.snapshot.bind(files)
  files.snapshot=async()=>{snapshots++;return snapshot()}
  await runtime.wake(request);await runtime.runQueue();await runtime.runQueue()
  assert.equal(snapshots,0)
  assert.equal(Boolean([...rows.values()].find((row:any)=>row.request?.id===request.id)?.delivered),false)
})

test('ready admission checks signal existence and ended Task in one fresh view without fetching signal bytes', async t => {
  const {runtime,files,rows}=await runtimeFixture(t),taskId='ended-admission',signal=paths.state('A',taskId)+'/Planner_Inbox'
  await withSnapshot(files,snapshot=>files.commit(snapshot,[{path:signal,content:''},{path:paths.task(taskId),content:encodeJson({version:1,taskId,route:'P',owner:'A',sourcePath:'tasks/end_P.md',status:'complete'})}],'already ended'))
  let snapshots=0,signalReads=0
  const snapshot=files.snapshot.bind(files),read=files.readBytes.bind(files)
  files.snapshot=async()=>{snapshots++;return snapshot()}
  files.readBytes=async(current,path)=>{if(path===signal)signalReads++;return read(current,path)}
  await runtime.wake({id:'ended-signal',role:'Planner',taskId,reason:'notification',sources:[{path:signal,version:'old'}]})
  await runtime.runQueue()
  assert.equal(snapshots,1)
  assert.equal(signalReads,0)
  assert.equal([...rows.values()].find((row:any)=>row.request?.id==='ended-signal')?.delivered,true)
})

test('runtime closes admission and cancels its owned transport before waiting for the active poll',async t=>{
  const {runtime}=await runtimeFixture(t)
  let release!:()=>void,cancelled=0
  const blocked=new Promise<void>(r=>{release=r})
  runtime.loop={stop:async()=>{await blocked}}
  runtime.environment.cancelPending=()=>{assert.equal(runtime.closed,true);cancelled++;release()}
  const disposing=runtime.dispose()
  try {await new Promise(r=>setImmediate(r));assert.equal(cancelled,1)}
  finally {release();await disposing}
})

for (const outcome of ['owned-read', 'independent-abort', 'unknown-write'] as const) test(`shutdown drains native owners after ${outcome} and preserves only actual failures`, async t => {
  const { runtime } = await runtimeFixture(t), pending = Promise.withResolvers<void>()
  let nativeStopped = 0, observationsClosed = 0
  const unrelated = new DOMException('Independent cancelled request', 'AbortError')
  const unknown = new FilesOutcomeUnknownError('pending-write')
  runtime.loop = { stop: () => pending.promise }
  runtime.roleRecords.set('owned', { identity: { workId: 'owned', executionId: 'e', role: 'Worker' } })
  runtime.stopOwnedRecord = async () => { nativeStopped++; return { status: 'stopped' } }
  runtime.observations.dispose = async () => { observationsClosed++ }
  runtime.environment.cancelPending = (reason: unknown) => pending.reject(outcome === 'owned-read' ? reason : outcome === 'unknown-write' ? unknown : unrelated)
  if (outcome === 'owned-read') await runtime.dispose()
  else await assert.rejects(runtime.dispose(), (error: unknown) => error === (outcome === 'unknown-write' ? unknown : unrelated))
  assert.equal(nativeStopped, 1)
  assert.equal(observationsClosed, 1)
})

/** Real LocalFiles and production capture/retirement with a recorded native-log
 * seam. Actual AgentLoop/JSONL round boundaries have their own current suite. */
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

test('Foreground capture UNKNOWN preserves the original session until the same native message receipt resolves', async t => {
  const {runtime,record}=await completedForegroundFixture(t)
  const originalSend=runtime.conversation.send.bind(runtime.conversation), commands:string[]=[]
  let first=true, stops=0
  runtime.stopOwnedRecord=async()=>{stops++;return{status:'stopped'}}
  runtime.conversation.send=async(command:string,message:any)=>{commands.push(command);const receipt=await originalSend(command,message);if(first){first=false;throw new FilesOutcomeUnknownError('capture-original-op',undefined,receipt)}return receipt}
  await assert.rejects(runtime.finishForegroundRound(record),FilesOutcomeUnknownError)
  assert.equal(stops,0);assert.equal(runtime.roleRecords.get(record.identity.workId).completedRound,undefined)
  assert.equal((await runtime.conversation.page(20)).messages.filter((message:any)=>message.role==='assistant').length,1)
  await runtime.finishForegroundRound(runtime.roleRecords.get(record.identity.workId))
  await Promise.all([...runtime.stopOperations.values()].map((stop:any)=>stop.promise))
  assert.equal(commands[0],commands[1]);assert.equal(stops,1)
  const replies=(await runtime.conversation.page(20)).messages.filter((message:any)=>message.role==='assistant')
  assert.equal(replies.length,1);assert.equal(replies[0].text,'  actual answer\n原文');assert.equal(replies[0].replyTo,'human')
  assert.equal(runtime.roleRecords.get(record.identity.workId).completedRound,true)
})

test('Foreground completed capture survives a crash before retirement without replaying or duplicating the answer', async t => {
  const {runtime,record,storage}=await completedForegroundFixture(t)
  let stops=0
  runtime.stopOwnedRecord=async()=>{stops++;return{status:'stopped'}}
  const tracked=runtime.trackedStop.bind(runtime)
  runtime.trackedStop=()=>false // Crash boundary: completedRound is durable, no stop starts.
  await runtime.finishForegroundRound(record)
  assert.equal(stops,0)
  const saved=(await storage.list<any>(runtime.prefix+'roles/'))[0]!.value
  assert.equal(saved.completedRound,true);assert.equal(saved.stopped,undefined)
  runtime.roleRecords.set(saved.identity.workId,structuredClone(saved));runtime.trackedStop=tracked
  runtime.conversation.send=async()=>{throw new Error('Completed capture must not be replayed')}
  await runtime.finishForegroundRound(saved)
  await Promise.all([...runtime.stopOperations.values()].map((stop:any)=>stop.promise))
  assert.equal(stops,1);assert.equal(runtime.roleRecords.get(saved.identity.workId).stopped,true)
})

test('Foreground retirement owns a pending stop without blocking unrelated work or declaring it stopped', async t => {
  const {runtime,record}=await completedForegroundFixture(t)
  let release!:()=>void
  runtime.stopOwnedRecord=async()=>{await new Promise<void>(resolve=>{release=resolve});return{status:'stopped'}}
  await runtime.finishForegroundRound(record)
  await Promise.resolve()
  assert.equal(runtime.roleRecords.get(record.identity.workId).completedRound,true)
  assert.notEqual(runtime.roleRecords.get(record.identity.workId).stopped,true)
  let advanced=false
  await runtime.serialWork('independent-task-worker',async()=>{advanced=true})
  assert.equal(advanced,true)
  release();await Promise.all([...runtime.stopOperations.values()].map((stop:any)=>stop.promise))
  assert.equal(runtime.roleRecords.get(record.identity.workId).stopped,true)
})

for (const stopFailure of [false,true]) test('runtime disposal drains admitted Foreground capture before storage release even when native cleanup '+(stopFailure?'fails':'succeeds'), async()=>{
  const {runtime}=queue(),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),events:string[]=[]
  runtime.closed=false;runtime.errorTail=Promise.resolve();runtime.environment={}
  runtime.loop={stop:async()=>{events.push('loop-stopped')}}
  runtime.roleRecords=new Map(stopFailure?[['worker',{identity:{workId:'worker',executionId:'worker-e',role:'Worker'},sessionId:'worker-s',generation:1}]]:[])
  const failure=new Error('Actual native cleanup failure')
  runtime.stopOwnedRecord=async()=>{throw failure}
  runtime.observations={dispose:async()=>{events.push('observations-disposed')}}
  const capture=runtime.serialWork('foreground',async()=>{entered.resolve();await gate.promise;events.push('capture-persisted')})
  await entered.promise
  let settled=false
  const disposing=runtime.dispose().then(()=>{settled=true},(error:unknown)=>{assert.equal(error,failure);settled=true})
  await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false)
  gate.resolve();await capture;await disposing
  assert.equal(events.includes('capture-persisted'),true);assert.equal(settled,true)
})
