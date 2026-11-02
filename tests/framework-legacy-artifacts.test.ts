import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, stat, open, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { LocalFiles } from '../src/framework/local-files.js'
import { FrameworkTransactions } from '../src/framework/command-transactions.js'
import { FrameworkConversation } from '../src/framework/conversation.js'
import { captureLocalLegacy, prepareLegacyMigration, applyLegacyMigration, type LegacyCapture } from '../src/framework/legacy-migration.js'
import { captureLegacyArtifacts, listLegacyArtifactReferences, resumePendingLegacyArtifacts, type LegacyArtifactIssue } from '../src/framework/legacy-artifacts.js'
import { FilesConflictError, FilesOutcomeUnknownError, withSnapshot } from '../src/framework/transactions.js'
import { loadBaselineModule, readBaselineSource } from './legacy-baseline.js'
import { MemoryStorage } from './support.js'
import type { StoragePort } from '../src/contracts/ports.js'
import type { Task, ArtifactRef } from '../src/contracts/task.js'
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const original = Uint8Array.from([0, 255, 128, ...Buffer.from('旧完整附件🙂\r\nUnicode e\u0301')])
let producer = readBaselineSource('tests/task-fixture.ts').replace('fixture(request?: string)', "fixture(workspace: string, taskId = 'one')")
  .replace('taskInput()', 'taskInput(taskId)').replace('if (request) input.goal.request = request', 'input.workspace.directory = workspace')
  .replaceAll("tasks.get('one')", 'tasks.get(taskId)').replaceAll("tasks.execute('one',", 'tasks.execute(taskId,')
producer += `
export async function produce(workspace, artifacts, taskId='one', deliveryArtifacts=artifacts, extraText='', keepLive=false) {
 const f=await fixture(workspace,taskId), planner=await f.bind('plan');
 assert.equal((await f.execute({type:'planning.commit',expectedGoalRevision:1,expectedPlanRevision:0,strategy:'Produce artifact',children:[childSpec()]},planner.source)).status,'applied');
 const worker=await f.bind('dispatch');
 assert.equal((await f.execute({type:'execution.report',report:{resultId:'accepted-output',assignmentVersion:1,outcome:'complete',summary:'Actual output',artifacts,evidence:['Actual output'],frontier:'Ready'}},worker.source)).status,'applied');
 const evaluator=await f.bind('evaluate');
 assert.equal((await f.execute({type:'planning.decide',expectedGoalRevision:1,summary:'Complete',decisions:[{childId:'a',resultId:'accepted-output',outcome:'accept',reason:'Matches'}],deliver:{id:'delivery-one',summary:'Ready',artifacts:deliveryArtifacts}},evaluator.source)).status,'applied');
 for(const execution of Object.values((await f.get()).executions)) assert.equal((await f.execute({type:'execution.observed',executionId:execution.executionId,physicalState:'stopped',ownedJobIds:[]})).status,'applied');
 for(const action of Object.values((await f.get()).pendingActions).filter(a=>a.status==='pending')) {
  assert.equal((await f.execute({type:'action.claim',actionId:action.id,ownerId:'runtime'})).status,'applied');
  assert.equal((await f.execute({type:'action.finish',actionId:action.id,notificationId:action.kind==='deliver'?'stable-wake':undefined})).status,'applied');
 }
 if(extraText)await f.store.journal.append({scope:{kind:'planner-memory',taskId},commandId:'large-original-history',text:extraText,source:f.runtime});
 const task=await f.get(); if(!keepLive)await f.tasks.cleanupCompleted(taskId); return {storage:f.storage,task};
}
export async function staged(workspace,artifacts) {
 const f=await fixture(workspace),planner=await f.bind('plan');
 assert.equal((await f.execute({type:'planning.commit',expectedGoalRevision:1,expectedPlanRevision:0,strategy:'Produce artifact',children:[childSpec()]},planner.source)).status,'applied');
 const worker=await f.bind('dispatch');
 f.storage.fail=key=>key.startsWith('worker-reply/one/');
 await assert.rejects(f.execute({type:'execution.report',report:{resultId:'pending-output',assignmentVersion:1,outcome:'complete',summary:'Actual pending output',artifacts,evidence:['Actual bytes'],frontier:'Ready'}},worker.source),/interruption/);
 f.storage.fail=undefined; assert.ok(await f.storage.get('task-staging/one/commit')); return f.storage;
}`
const baseline = await loadBaselineModule<{ staged(workspace:string,artifacts:ArtifactRef[]):Promise<StoragePort>; produce(workspace: string, artifacts: ArtifactRef[], taskId?: string, deliveryArtifacts?: ArtifactRef[], extraText?: string, keepLive?: boolean): Promise<{storage: StoragePort; task: Task}> }>('tests/task-fixture.ts', producer)
/** Real file reads behind the documented canonical FS capability contract.
 * Native rc.5 provider is additionally exercised in isolated QA, not packaged. */
async function filesystem() {
  const reads: string[] = []
  const fs = {
    resolve: async (path: string, options?: {cwd?: string; signal?: AbortSignal}) => { options?.signal?.throwIfAborted(); return { path: await realpath(resolve(options?.cwd ?? process.cwd(), path)) } },
    contains: (parent: {path: string}, child: {path: string}) => { const value = relative(parent.path, child.path); return value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value) },
    stat: async (target: {path: string}, signal?: AbortSignal) => { signal?.throwIfAborted(); const value = await stat(target.path, {bigint:true}); return {type:value.isFile()?'file':'directory',version:[value.dev,value.ino,value.size,value.mtimeNs,value.ctimeNs].join(':'),size:Number(value.size)} },
    readByteRange: async (target: {path: string}, range: {offset:number;length:number}, signal?: AbortSignal) => {
      signal?.throwIfAborted(); reads.push(target.path); const handle = await open(target.path,'r')
      try { const buffer=Buffer.alloc(range.length), result=await handle.read(buffer,0,range.length,range.offset); return buffer.subarray(0,result.bytesRead) } finally { await handle.close() }
    },
  }
  return {ctx:{fs} as unknown as Pick<Context,'fs'>,reads,close:async()=>{}}
}
async function fixture(t: test.TestContext) {
  const root=await mkdtemp(join(tmpdir(),'dss-legacy-artifacts-')),workspace=join(root,'workspace')
  await mkdir(workspace); const files=await LocalFiles.open(join(root,'authority')),records=new MemoryStorage(),transactions=new FrameworkTransactions(files,records,'legacy-artifacts')
  const {ctx,reads,close}=await filesystem()
  t.after(async()=>{await close();await files.close();await rm(root,{recursive:true,force:true})})
  const produce=async(artifacts: ArtifactRef[]=[{id:'original',path:'result.bin',description:'Accepted output',sha256:hash(original)}],taskId='one')=>{
    const old=await baseline.produce(workspace,artifacts,taskId); assert.equal(await old.storage.get('task:'+taskId),undefined)
    return {old,capture:await captureLocalLegacy(old.storage)}
  }
  const migrate=async(capture:LegacyCapture,id='upgrade',captureBytes=false)=>{
    const artifacts=captureBytes?await captureLegacyArtifacts(ctx,capture):undefined
    const plan=await withSnapshot(files,snapshot=>prepareLegacyMigration(capture,files,snapshot,{id,owner:'alice',members:{assistant:'alice'},artifacts}))
    await applyLegacyMigration(files,transactions,plan);return plan
  }
  const list=(path:string)=>withSnapshot(files,snapshot=>listLegacyArtifactReferences(files,snapshot,path))
  return {root,workspace,files,records,transactions,ctx,reads,produce,migrate,list}
}
test('real legacy report/accept/archive producer imports actual authorized bytes at initial cutover',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'result.bin'),original)
  const {capture}=await f.produce(),plan=await f.migrate(capture,'first',true),refs=await f.list(plan.manifestPath)
  assert.equal(refs.length,1);assert.equal(refs[0]!.status,'archived');assert.ok(refs[0]!.archivedPath)
  assert.deepEqual(await withSnapshot(f.files,s=>f.files.readBytes(s,refs[0]!.archivedPath!)),original)
  assert.deepEqual(await readFile(join(f.workspace,'result.bin')),Buffer.from(original));assert.ok(f.reads.length>0)
  assert.equal(plan.manifest.pendingAdapters.some(v=>v.startsWith('artifact-bytes:')),false)
})
test('already verified migration with real pending bytes is supplemented without rerunning old cutover or creating a Task',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'result.bin'),original)
  const {capture}=await f.produce(),plan=await f.migrate(capture)
  assert.ok(plan.manifest.pendingAdapters.includes('artifact-bytes:one:original'))
  assert.equal((await f.list(plan.manifestPath))[0]!.archivedPath,undefined)
  const before=await withSnapshot(f.files,s=>f.files.read(s,plan.manifest.tasks[0]!.recordPath))
  const result=await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)
  assert.equal(result.pending.length,0);assert.equal(result.attached.length,1)
  const refs=await f.list(plan.manifestPath);assert.equal(refs[0]!.status,'archived')
  assert.deepEqual(await withSnapshot(f.files,s=>f.files.readBytes(s,result.attached[0]!)),original)
  assert.equal(await withSnapshot(f.files,s=>f.files.read(s,plan.manifest.tasks[0]!.recordPath)),before)
  assert.deepEqual(await withSnapshot(f.files,s=>f.files.list(s,'tasks/')),[])
  assert.deepEqual(await withSnapshot(f.files,s=>f.files.list(s,'state/')),[])
})
test('external and symlink-escaping declared artifacts remain discoverable but no content byte is read',async t=>{
  const f=await fixture(t),outside=join(f.root,'outside.bin');await writeFile(outside,original);await symlink(outside,join(f.workspace,'escape.bin'))
  const {capture}=await f.produce([{id:'external',path:outside,description:'Original external',sha256:hash(original)},{id:'symlink',path:'escape.bin',description:'Alias',sha256:hash(original)}])
  const issues:LegacyArtifactIssue[]=[];assert.deepEqual(await captureLegacyArtifacts(f.ctx,capture,{onIssue:i=>issues.push(i)}),[])
  assert.equal(issues.length,2);assert.ok(issues.every(i=>/outside/.test(i.detail)));assert.deepEqual(f.reads,[])
  const plan=await f.migrate(capture),result=await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)
  assert.equal(result.pending.length,2);assert.deepEqual(result.attached,[]);assert.deepEqual(f.reads,[])
  const refs=await f.list(plan.manifestPath);assert.equal(refs.length,2);assert.ok(refs.every(r=>r.status==='pending'&&!r.archivedPath))
  assert.equal(refs.find(r=>r.id==='external')!.sourcePath,outside);assert.equal(refs[0]!.sha256,hash(original));assert.equal('error' in refs[0]!,false)
})
test('one missing or hash-damaged artifact cannot hide another actual accepted artifact',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'good.bin'),original);await writeFile(join(f.workspace,'bad.bin'),'changed')
  const {capture}=await f.produce(['good','bad','missing'].map(id=>({id,path:id+'.bin',description:id,sha256:hash(original)}))),plan=await f.migrate(capture)
  const result=await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)
  assert.equal(result.attached.length,1);assert.equal(result.pending.length,2);assert.ok(result.pending.every(i=>i.error instanceof Error))
  assert.equal((await f.list(plan.manifestPath)).filter(r=>r.status==='archived').length,1)
})
for(const committed of [true,false]) test(`same artifact command resumes actual ${committed?'committed lost acknowledgement':'not committed UNKNOWN'} before touching changed source`,async t=>{
  const f=await fixture(t);const source=join(f.workspace,'result.bin');await writeFile(source,original)
  const {capture}=await f.produce(),plan=await f.migrate(capture),commit=f.files.commit.bind(f.files)
  let lost=false
  f.files.commit=async(snapshot,changes,message)=>{
    if(!lost&&changes.some(change=>change.path.startsWith('technical/legacy-artifacts/'))){lost=true;const receipt=committed?await commit(snapshot,changes,message):undefined;throw new FilesOutcomeUnknownError('same-original-local-operation',undefined,receipt)}
    return commit(snapshot,changes,message)
  }
  const first=await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)
  assert.equal(first.attached.length,0);assert.ok(first.pending[0]!.error instanceof FilesOutcomeUnknownError)
  f.reads.length=0
  if(committed)await rm(source)
  else await writeFile(source,'changed source must fail original hash')
  const second=await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)
  if(committed){assert.equal(second.attached.length,1);assert.deepEqual(f.reads,[])}
  else {
    assert.equal(second.attached.length,0);assert.match(second.pending[0]!.detail,/recorded hash/)
    await writeFile(source,original)
    assert.equal((await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)).attached.length,1)
  }
})
test('different original Task workspaces with the same relative name never share captured bytes',async t=>{
  const f=await fixture(t),workspace2=join(f.root,'workspace2');await mkdir(workspace2)
  const other=Buffer.from('Different actual result');await writeFile(join(f.workspace,'result.bin'),original);await writeFile(join(workspace2,'result.bin'),other)
  const first=await f.produce(),second=await baseline.produce(workspace2,[{id:'original',path:'result.bin',description:'Other accepted',sha256:hash(other)}],'two')
  const combined=new MemoryStorage();for(const store of [first.old.storage,second.storage])for(const row of await store.list(''))await combined.set(row.key,row.value)
  const capture=await captureLocalLegacy(combined),plan=await f.migrate(capture,'scoped',true),refs=await f.list(plan.manifestPath)
  assert.equal(refs.length,2);assert.notEqual(refs[0]!.archivedPath,refs[1]!.archivedPath)
  for(const ref of refs)assert.deepEqual(await withSnapshot(f.files,s=>f.files.readBytes(s,ref.archivedPath!)),ref.oldTaskId==='one'?original:Uint8Array.from(other))
  const unscoped=await withSnapshot(f.files,s=>prepareLegacyMigration(capture,f.files,s,{id:'unscoped',owner:'alice',members:{assistant:'alice'},artifacts:[{sourcePath:'result.bin',bytes:original}]}))
  assert.equal(unscoped.manifest.pendingAdapters.filter(v=>v.startsWith('artifact-bytes:')).length,2)
})
test('source mutation during capture, explicit cancellation and altered archive destination never publish false completion',async t=>{
  const f=await fixture(t),source=join(f.workspace,'result.bin');await writeFile(source,original)
  const {capture}=await f.produce(),plan=await f.migrate(capture),read=f.ctx.fs.readByteRange.bind(f.ctx.fs)
  let changed=false;f.ctx.fs.readByteRange=async(target,range,signal)=>{const bytes=await read(target,range,signal);if(!changed){changed=true;await writeFile(source,'late mutation')}return bytes}
  const first=await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath);assert.equal(first.attached.length,0);assert.match(first.pending[0]!.detail,/changed while/)
  f.ctx.fs.readByteRange=read;await writeFile(source,original)
  const controller=new AbortController(),reason=new Error('Exact owner cancelled artifact upgrade');controller.abort(reason)
  await assert.rejects(resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath,{signal:controller.signal}),e=>e===reason)
  const path='archives/'+plan.manifest.tasks[0]!.taskId+'/legacy/artifacts/'+hash('result.bin')+'/result.bin'
  await withSnapshot(f.files,s=>f.files.commit(s,[{path,content:'Existing different target'}],'synthetic destination collision'))
  // Existing failed command records first expose the proven Files revision conflict.
  await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)
  const collision=await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)
  assert.equal(collision.attached.length,0);assert.match(collision.pending[0]!.detail,/different bytes/)
  assert.equal(await withSnapshot(f.files,s=>f.files.read(s,path)),'Existing different target')
})
test('read-only discovery rejects modified preserved source and never reads the original filesystem',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'result.bin'),original)
  const {capture}=await f.produce(),plan=await f.migrate(capture),record=plan.manifest.records.find(row=>row.key==='records/one/manifest')!
  await withSnapshot(f.files,s=>f.files.commit(s,[{path:record.path,content:'Modified preserved declaration'}],'synthetic corruption'))
  await assert.rejects(f.list(plan.manifestPath),/missing or corrupt/);assert.deepEqual(f.reads,[])
})


test('actual old delivery-only declaration is preserved as well as report artifacts',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'result.bin'),original)
  const old=await baseline.produce(f.workspace,[],'one',[{id:'delivery-only',path:'result.bin',description:'Delivery attachment',sha256:hash(original)}])
  assert.equal(Object.values(old.task.reports).flatMap(r=>r.artifacts).length,0)
  const capture=await captureLocalLegacy(old.storage),plan=await f.migrate(capture,'delivery',true)
  const refs=await f.list(plan.manifestPath);assert.equal(refs.length,1);assert.equal(refs[0]!.id,'delivery-only');assert.equal(refs[0]!.status,'archived')
})
test('different historical artifact ids at one path keep their original hashes and do not misbind captured bytes',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'result.bin'),original)
  const {capture}=await f.produce([{id:'old-version',path:'result.bin',description:'Old',sha256:hash('old bytes no longer present')},{id:'current-version',path:'result.bin',description:'Current',sha256:hash(original)}])
  const issues:LegacyArtifactIssue[]=[],artifacts=await captureLegacyArtifacts(f.ctx,capture,{onIssue:i=>issues.push(i)})
  assert.equal(artifacts.length,1);assert.equal(artifacts[0]!.artifactId,'current-version');assert.equal(issues.length,1)
  const plan=await withSnapshot(f.files,s=>prepareLegacyMigration(capture,f.files,s,{id:'versions',owner:'alice',members:{assistant:'alice'},artifacts}))
  await applyLegacyMigration(f.files,f.transactions,plan)
  assert.ok(plan.manifest.pendingAdapters.includes('artifact-bytes:one:old-version'))
  const refs=await f.list(plan.manifestPath);assert.equal(refs.find(r=>r.id==='old-version')!.status,'pending');assert.equal(refs.find(r=>r.id==='current-version')!.status,'archived')
})
test('same declared id with conflicting paths is diagnostic, not permission to choose one readable file',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'first.bin'),original)
  const {capture}=await f.produce([{id:'conflict',path:'first.bin',description:'First'},{id:'conflict',path:'second.bin',description:'Second'}])
  const issues:LegacyArtifactIssue[]=[];assert.deepEqual(await captureLegacyArtifacts(f.ctx,capture,{onIssue:i=>issues.push(i)}),[])
  assert.match(issues[0]!.detail,/Ambiguous/);assert.deepEqual(f.reads,[])
  const plan=await f.migrate(capture);assert.ok(plan.manifest.pendingAdapters.includes('artifact-declarations:one'))
  const refs=await f.list(plan.manifestPath);assert.equal(refs[0]!.status,'unavailable');assert.equal('error' in refs[0]!,false)
})
test('manual cleared migration identity is not reimported even if its original accepted file remains',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'result.bin'),original)
  const {capture}=await f.produce(),plan=await f.migrate(capture)
  await withSnapshot(f.files,s=>f.files.commit(s,[{path:plan.manifestPath,content:JSON.stringify({...plan.manifest,clearedTasks:[{oldId:'one',taskId:plan.manifest.tasks[0]!.taskId}]})}],'synthetic confirmed manual cleanup receipt'))
  assert.deepEqual(await f.list(plan.manifestPath),[])
  assert.deepEqual(await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath),{attached:[],pending:[]});assert.deepEqual(f.reads,[])
})
test('UNKNOWN of one artifact stays its same operation while another artifact is actually preserved',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'first.bin'),original);await writeFile(join(f.workspace,'second.bin'),original)
  const {capture}=await f.produce(['first','second'].map(id=>({id,path:id+'.bin',description:id,sha256:hash(original)}))),plan=await f.migrate(capture),commit=f.files.commit.bind(f.files)
  let lost=false
  f.files.commit=async(snapshot,changes,message)=>{
    if(!lost&&changes.some(c=>c.path.startsWith('technical/legacy-artifacts/'))){lost=true;throw new FilesOutcomeUnknownError('first-original-operation')}
    return commit(snapshot,changes,message)
  }
  const first=await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)
  assert.equal(first.attached.length,1);assert.ok(first.pending[0]!.error instanceof FilesOutcomeUnknownError)
  const keys=[...f.records.data.keys()]
  await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath) // proven changed authority revision
  const final=await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)
  assert.equal(final.attached.length,2);assert.equal(final.pending.length,0)
  assert.deepEqual([...f.records.data.keys()],keys,'No fresh command identity replaces the pending operation')
})

test('previously verified tasks-empty migration discovers and imports original sealed artifact declarations without inventing a Task or pending marker',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'result.bin'),original)
  const {capture}=await f.produce()
  // Exact previous consumer shape: real TaskService.cleanupCompleted removed
  // task:one; the older capture preserved sealed source but omitted tasks/text.
  capture.tasks=[];capture.texts=capture.texts.filter(row=>row.ref!=='records/one/records.md')
  const plan=await f.migrate(capture,'old-history-only')
  assert.deepEqual(plan.manifest.tasks,[]);assert.equal(plan.manifest.pendingAdapters.some(v=>v.startsWith('artifact-bytes:')),false)
  assert.equal((await f.list(plan.manifestPath))[0]!.status,'pending')
  const result=await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)
  assert.equal(result.pending.length,0);assert.equal(result.attached.length,1)
  assert.deepEqual(await withSnapshot(f.files,s=>f.files.readBytes(s,result.attached[0]!)),original)
  const manifest=JSON.parse((await withSnapshot(f.files,s=>f.files.read(s,plan.manifestPath)))!)
  assert.deepEqual(manifest.tasks,[]);assert.deepEqual(manifest.pendingAdapters,plan.manifest.pendingAdapters)
  assert.deepEqual(await withSnapshot(f.files,s=>f.files.list(s,'tasks/')),[])
  assert.deepEqual(await withSnapshot(f.files,s=>f.files.list(s,'state/')),[])
  f.reads.length=0
  assert.equal((await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)).attached.length,1)
  assert.deepEqual(f.reads,[],'same completed artifact command does not recapture its original filesystem source')
})

test('FS native AbortError cause preserves the exact owner while an independent late AbortError stays a real issue',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'result.bin'),original)
  const {capture}=await f.produce(),controller=new AbortController(),reason=new Error('Own original upgrade stop')
  const native=new Error('Native file read aborted',{cause:reason});native.name='AbortError'
  f.ctx.fs.readByteRange=async()=>{controller.abort(reason);throw native}
  const issues:LegacyArtifactIssue[]=[]
  await assert.rejects(captureLegacyArtifacts(f.ctx,capture,{signal:controller.signal,onIssue:i=>issues.push(i)}),error=>error===native)
  assert.equal(issues.length,0)
  const unrelated=new Error('Independent earlier file failure');unrelated.name='AbortError'
  const later=new AbortController()
  f.ctx.fs.readByteRange=async()=>{later.abort(reason);throw unrelated}
  assert.deepEqual(await captureLegacyArtifacts(f.ctx,capture,{signal:later.signal,onIssue:i=>issues.push(i)}),[])
  assert.equal(issues[0]!.error,unrelated)
})


test('artifact declaration discovery never reads unrelated old conversations, knowledge or the sealed records document',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'result.bin'),original)
  const artifact={id:'original',path:'result.bin',description:'Accepted output',sha256:hash(original)}
  const old=await baseline.produce(f.workspace,[artifact],'one',undefined,'Long exact old journal body '.repeat(20000))
  await old.storage.set('conversations/unrelated/2026-01-01/content/unrelated',{text:'Unrelated conversation body'})
  await old.storage.set('knowledge/unrelated/fact',{text:'Unrelated long-term knowledge'})
  const capture=await captureLocalLegacy(old.storage),plan=await f.migrate(capture)
  const sealed=await old.storage.get<{snapshot:Array<{key:string}>}>('records/one/manifest'),snapshotParts=new Set(sealed!.snapshot.map(part=>part.key))
  const forbidden=new Set(plan.manifest.records.filter(row=>row.key.startsWith('conversations/')||row.key.startsWith('knowledge/')||row.key.startsWith('planner-memory/')
    ||row.key.startsWith('records/one/content/')&&!snapshotParts.has(row.key)).map(row=>row.path))
  assert.ok(forbidden.size>3)
  const read=f.files.readBytes.bind(f.files),seen:string[]=[]
  f.files.readBytes=async(snapshot,path)=>{seen.push(path);assert.equal(forbidden.has(path),false,'Artifact lookup read unrelated original body: '+path);return read(snapshot,path)}
  assert.equal((await f.list(plan.manifestPath)).length,1)
  assert.equal((await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)).attached.length,1)
  assert.equal(seen.some(path=>forbidden.has(path)),false)
})
test('still-present separated Task root loads only original report records needed for artifact declarations',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'result.bin'),original)
  const artifact={id:'original',path:'result.bin',description:'Accepted output',sha256:hash(original)}
  const old=await baseline.produce(f.workspace,[artifact],'one',undefined,'Unrelated live planning journal '.repeat(10000),true)
  assert.ok((await old.storage.get<any>('task:one')).recordsLayout)
  const capture=await captureLocalLegacy(old.storage),plan=await f.migrate(capture)
  const forbidden=new Set(plan.manifest.records.filter(row=>!row.key.startsWith('task:')&&!row.key.startsWith('worker-reply/')&&!row.key.startsWith('task-staging/')).map(row=>row.path))
  const read=f.files.readBytes.bind(f.files)
  f.files.readBytes=async(snapshot,path)=>{assert.equal(forbidden.has(path),false,'Artifact lookup loaded unrelated live record: '+path);return read(snapshot,path)}
  assert.equal((await f.list(plan.manifestPath)).length,1)
  assert.equal((await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)).attached.length,1)
})


test('actual old interrupted report staging is reconstructed only in memory for artifact declaration reads',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'result.bin'),original)
  const artifact={id:'pending-original',path:'result.bin',description:'Produced before interruption',sha256:hash(original)}
  const storage=await baseline.staged(f.workspace,[artifact]),before=JSON.stringify(await storage.list(''))
  const capture=await captureLocalLegacy(storage),plan=await f.migrate(capture)
  const read=f.files.readBytes.bind(f.files),forbidden=new Set(plan.manifest.records.filter(row=>!row.key.startsWith('task:')&&!row.key.startsWith('worker-reply/')&&!row.key.startsWith('task-staging/')).map(row=>row.path))
  f.files.readBytes=async(snapshot,path)=>{assert.equal(forbidden.has(path),false,'Pending artifact lookup read unrelated body');return read(snapshot,path)}
  const refs=await f.list(plan.manifestPath);assert.equal(refs.length,1);assert.equal(refs[0]!.id,artifact.id)
  assert.equal((await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)).attached.length,1)
  assert.equal(JSON.stringify(await storage.list('')),before,'Original staged command/source remain untouched')
})

for(const initial of [true,false]) test(`completed ${initial?'initial migration':'supplement'} artifact reconnect and Archives use exact Local metadata without rereading large binary`,async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'result.bin'),original)
  const {capture}=await f.produce(),plan=await f.migrate(capture,'completed-metadata',initial)
  if(!initial)assert.equal((await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)).attached.length,1)
  await rm(join(f.workspace,'result.bin')) // Confirmed preservation must not need the old file again.
  const path=(await f.list(plan.manifestPath))[0]!.archivedPath!,read=f.files.readBytes.bind(f.files),reads:string[]=[]
  f.files.readBytes=async(snapshot,target)=>{if(target===path)reads.push(target);return read(snapshot,target)}
  f.reads.length=0
  assert.equal((await f.list(plan.manifestPath))[0]!.status,'archived')
  assert.equal((await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)).pending.length,0)
  assert.deepEqual(reads,[]);assert.deepEqual(f.reads,[])
})
test('actual UNKNOWN artifact readback still reads authoritative bytes once, then later confirmed reconnect does not',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'result.bin'),original)
  const {capture}=await f.produce(),plan=await f.migrate(capture,'unknown-metadata'),commit=f.files.commit.bind(f.files)
  let lost=false
  f.files.commit=async(snapshot,changes,message)=>{const receipt=await commit(snapshot,changes,message);if(!lost&&changes.some(c=>c.path.startsWith('technical/legacy-artifacts/'))){lost=true;throw new FilesOutcomeUnknownError('true-lost-ack',undefined,receipt)}return receipt}
  const first=await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)
  assert.ok(first.pending[0]!.error instanceof FilesOutcomeUnknownError)
  const path=(await f.list(plan.manifestPath))[0]!.archivedPath!,read=f.files.readBytes.bind(f.files);let binaryReads=0
  f.files.readBytes=async(snapshot,target)=>{if(target===path)binaryReads++;return read(snapshot,target)}
  assert.equal((await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)).attached.length,1)
  assert.ok(binaryReads>0,'Real unknown result requires full original readback')
  binaryReads=0
  assert.equal((await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)).attached.length,1)
  assert.equal(binaryReads,0)
})
for(const missing of [false,true]) test(`changed Local artifact ${missing?'absence':'content version'} immediately removes download eligibility without silently reimporting original source`,async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'result.bin'),original)
  const {capture}=await f.produce(),plan=await f.migrate(capture,'changed-metadata')
  assert.equal((await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)).attached.length,1)
  const path=(await f.list(plan.manifestPath))[0]!.archivedPath!
  await withSnapshot(f.files,s=>f.files.commit(s,[{path,content:missing?null:'New different user-owned bytes'}],'synthetic explicit target change'))
  f.reads.length=0
  const ref=(await f.list(plan.manifestPath))[0]!
  assert.equal(ref.status,'unavailable');assert.equal(ref.archivedPath,undefined)
  const result=await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)
  assert.equal(result.attached.length,0);assert.equal(result.pending.length,1);assert.deepEqual(f.reads,[])
  assert.equal(await withSnapshot(f.files,s=>f.files.read(s,path)),missing?undefined:'New different user-owned bytes')
})

test('AUDIT confirmed reconnect counts actual original declaration reads for four independent artifacts',async t=>{
 const f=await fixture(t),artifacts=[0,1,2,3].map(n=>({id:'artifact-'+n,path:'result-'+n+'.bin',description:'Original output '+n,sha256:hash(original)}));
 for(const a of artifacts)await writeFile(join(f.workspace,a.path),original);
 const {capture}=await f.produce(artifacts),plan=await f.migrate(capture,'declaration-count');
 assert.equal((await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)).attached.length,4);
 const originalRead=f.files.readBytes.bind(f.files),seen=new Map<string,number>();
 f.files.readBytes=async(snapshot,path)=>{if(path.includes('/source/'))seen.set(path,(seen.get(path)??0)+1);return originalRead(snapshot,path)};
 const before=await withSnapshot(f.files,s=>Promise.resolve(s.revision));
 assert.equal((await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)).attached.length,4);
 const after=await withSnapshot(f.files,s=>Promise.resolve(s.revision));assert.equal(before,after,'no changed source authority or writes between checks');
 const counts=[...seen.values()];console.log('AUDIT declaration reads',JSON.stringify({artifacts:4,uniqueSourceRecords:seen.size,totalSourceReads:counts.reduce((a,b)=>a+b,0),counts}));
 assert.ok(counts.every(count=>count===1),'unchanged source declarations should not be decoded anew per already confirmed attachment');
});

test('reusing the fixed declaration view does not reuse stale artifact metadata after another Local commit',async t=>{
  const f=await fixture(t),artifacts=[0,1].map(n=>({id:'fresh-'+n,path:'fresh-'+n+'.bin',description:'Original '+n,sha256:hash(original)}))
  for(const artifact of artifacts)await writeFile(join(f.workspace,artifact.path),original)
  const {capture}=await f.produce(artifacts),plan=await f.migrate(capture,'fresh-target-metadata')
  assert.equal((await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)).attached.length,2)
  const changedPath=(await f.list(plan.manifestPath)).find(ref=>ref.id==='fresh-1')!.archivedPath!,confirmed=f.transactions.confirmed.bind(f.transactions)
  let changed=false
  f.transactions.confirmed=async(id,request)=>{
    if(!changed&&(request as {artifact?:ArtifactRef}).artifact?.id==='fresh-1'){
      changed=true;await withSnapshot(f.files,s=>f.files.commit(s,[{path:changedPath,content:'A later real Local commit'}],'synthetic target update during observation'))
    }
    return confirmed(id,request)
  }
  const result=await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)
  assert.equal(result.attached.length,1);assert.equal(result.pending.length,1);assert.equal(result.pending[0]!.id,'fresh-1')
  assert.match(result.pending[0]!.detail,/missing or changed/)
  assert.equal(await withSnapshot(f.files,s=>f.files.read(s,changedPath)),'A later real Local commit')
})


test('slow legacy artifact capture resumes its same operation after a real human conversation commit changes Local HEAD',async t=>{
  const f=await fixture(t),artifacts=[0,1].map(n=>({id:'slow-'+n,path:'slow-'+n+'.bin',description:'Accepted '+n,sha256:hash(original)}))
  for(const artifact of artifacts)await writeFile(join(f.workspace,artifact.path),original)
  const {capture}=await f.produce(artifacts),plan=await f.migrate(capture,'human-during-capture'),read=f.ctx.fs.readByteRange.bind(f.ctx.fs)
  let entered!:()=>void,release!:()=>void,held=false,settled=false
  const waiting=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
  f.ctx.fs.readByteRange=async(target,range,signal)=>{if(!held){held=true;entered();await gate}return read(target,range,signal)}
  const repair=resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath).finally(()=>{settled=true})
  await waiting
  try {
    const conversation=new FrameworkConversation(f.files,f.transactions,{mode:'local',collaborationId:'artifact-upgrade'})
    await conversation.send('concurrent-human-command',{id:'concurrent-human',participantId:'actual-user',role:'user',recipient:'human',createdAt:'2026-11-01T09:00:00.000Z',text:'Human message accepted while attachment capture is waiting'})
    assert.equal(settled,false,'Conversation completed before the held file read was released')
    assert.equal((await conversation.read('concurrent-human'))?.text,'Human message accepted while attachment capture is waiting')
  } finally { release() }
  const result=await repair
  assert.equal(result.pending.length,0,'A proven unrelated new HEAD must not strand the accepted repair until restart')
  assert.equal(result.attached.length,2)
  assert.ok((await f.list(plan.manifestPath)).every(ref=>ref.status==='archived'))
  const operations=f.records.writes.map(row=>row.value as {id?:string}).filter(row=>row.id?.startsWith('legacy-artifact:')).map(row=>row.id)
  assert.equal(new Set(operations).size,2,'One stable command per original artifact despite the retry')
})

test('each additional proven Local HEAD change reevaluates the same artifact command without a retry count gate',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'result.bin'),original)
  const {capture}=await f.produce(),plan=await f.migrate(capture,'several-real-heads'),commit=f.files.commit.bind(f.files)
  let attempts=0
  f.files.commit=async(snapshot,changes,message)=>{
    if(changes.some(change=>change.path.startsWith('technical/legacy-artifacts/'))){
      attempts++
      if(attempts<=3)await withSnapshot(f.files,s=>commit(s,[{path:'concurrent/fact-'+attempts,content:'Independent real authority change'}],'synthetic concurrent write'))
    }
    return commit(snapshot,changes,message)
  }
  const result=await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)
  assert.equal(result.attached.length,1);assert.equal(result.pending.length,0);assert.equal(attempts,4)
  const records=f.records.writes.map(row=>row.value as {id?:string;requestHash?:string}).filter(row=>row.id?.startsWith('legacy-artifact:'))
  assert.equal(new Set(records.map(record=>record.id)).size,1);assert.equal(new Set(records.map(record=>record.requestHash)).size,1)
})
test('a conflict with unchanged authoritative HEAD is reported once rather than guessed retryable',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'result.bin'),original)
  const {capture}=await f.produce(),plan=await f.migrate(capture,'same-head'),commit=f.files.commit.bind(f.files)
  let attempts=0,expected:FilesConflictError|undefined
  f.files.commit=async(snapshot,changes,message)=>{if(changes.some(change=>change.path.startsWith('technical/legacy-artifacts/'))){attempts++;throw expected=new FilesConflictError(snapshot.revision)}return commit(snapshot,changes,message)}
  const result=await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)
  assert.equal(attempts,1);assert.equal(result.attached.length,0);assert.equal(result.pending[0]!.error,expected)
})
for(const failure of ['unknown','permission'])test(`${failure} does not retry even when another real Local commit changed HEAD`,async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'result.bin'),original)
  const {capture}=await f.produce(),plan=await f.migrate(capture,'no-retry-'+failure),commit=f.files.commit.bind(f.files)
  let attempts=0
  const error=failure==='unknown'?new FilesOutcomeUnknownError('same-unresolved-original-operation'):Object.assign(new Error('Original write permission denied'),{code:'EACCES'})
  f.files.commit=async(snapshot,changes,message)=>{
    if(changes.some(change=>change.path.startsWith('technical/legacy-artifacts/'))){attempts++;await withSnapshot(f.files,s=>commit(s,[{path:'concurrent/independent',content:'A real changed HEAD'}],'synthetic concurrent write'));throw error}
    return commit(snapshot,changes,message)
  }
  const result=await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)
  assert.equal(attempts,1);assert.equal(result.attached.length,0);assert.equal(result.pending[0]!.error,error)
})
for(const changed of ['source-hash','permission','target','declaration'])test(`proven new HEAD still rechecks ${changed} before another artifact dispatch`,async t=>{
  const f=await fixture(t),source=join(f.workspace,'result.bin');await writeFile(source,original)
  const {capture}=await f.produce(),plan=await f.migrate(capture,'fresh-'+changed),commit=f.files.commit.bind(f.files)
  const target='archives/'+plan.manifest.tasks[0]!.taskId+'/legacy/artifacts/'+hash('result.bin')+'/result.bin'
  const outside=join(f.root,'outside-after-first-capture.bin');await writeFile(outside,original)
  let attempts=0
  f.files.commit=async(snapshot,changes,message)=>{
    if(changes.some(change=>change.path.startsWith('technical/legacy-artifacts/'))){
      attempts++
      if(attempts===1){
        if(changed==='source-hash')await writeFile(source,'Changed original bytes')
        if(changed==='permission'){await rm(source);await symlink(outside,source)}
        const path=changed==='target'?target:changed==='declaration'?plan.manifest.records.find(row=>row.key==='records/one/manifest')!.path:'concurrent/real-change'
        await withSnapshot(f.files,s=>commit(s,[{path,content:'New independent authoritative content'}],'synthetic concurrent authority change'))
      }
    }
    return commit(snapshot,changes,message)
  }
  const result=await resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath)
  assert.equal(attempts,1,'Fresh evaluation failure must not dispatch another write')
  assert.equal(result.attached.length,0);assert.equal(result.pending.length,1)
  assert.match(result.pending[0]!.detail,changed==='source-hash'?/recorded hash/:changed==='permission'?/outside/:changed==='target'?/different bytes/:/missing or corrupt/)
  assert.equal(f.reads.includes(outside),false)
  if(changed==='target')assert.equal(await withSnapshot(f.files,s=>f.files.read(s,target)),'New independent authoritative content')
})
test('caller cancellation after proven conflict prevents another capture or write while retaining the same operation facts',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'result.bin'),original)
  const {capture}=await f.produce(),plan=await f.migrate(capture,'cancel-at-conflict'),commit=f.files.commit.bind(f.files)
  const controller=new AbortController(),reason=new Error('Owner cancelled before the next evaluation');let attempts=0
  f.files.commit=async(snapshot,changes,message)=>{
    if(changes.some(change=>change.path.startsWith('technical/legacy-artifacts/'))){attempts++;await withSnapshot(f.files,s=>commit(s,[{path:'concurrent/kept',content:'Preserved independent work'}],'synthetic concurrent write'));controller.abort(reason)}
    return commit(snapshot,changes,message)
  }
  await assert.rejects(resumePendingLegacyArtifacts(f.ctx,f.files,f.transactions,plan.manifestPath,{signal:controller.signal}),error=>error===reason)
  assert.equal(attempts,1);assert.equal((await f.list(plan.manifestPath))[0]!.status,'pending')
  assert.equal(await withSnapshot(f.files,s=>f.files.read(s,'concurrent/kept')),'Preserved independent work')
  const records=f.records.writes.map(row=>row.value as {id?:string;conflicted?:boolean}).filter(row=>row.id?.startsWith('legacy-artifact:'))
  assert.equal(new Set(records.map(record=>record.id)).size,1);assert.equal(records.at(-1)!.conflicted,true)
})
