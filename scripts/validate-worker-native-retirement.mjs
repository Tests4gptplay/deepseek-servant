// Actual complete FrameworkRoleRuntime, registered SDK tools, official native
// AgentLoop/JSONL, production Cleaner and Local/Git stores. Tool inputs and
// admitted role metadata are fixture inputs, not model requests. Git transport
// and named failure/hold points are explicitly controlled. No Windows claim.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {rmSync} from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {evidence} from './test-support/dsh-sdk-runtime.mjs'
import {openDshStorageFixture} from './test-support/dsh-sdk-storage.mjs'
const {AgentRegistry}=await import('@deepseek-ai/dsh-agent')
const {SessionStore}=await import('@deepseek-ai/dsh-session')
const {SessionProjectionRegistry}=await import('@deepseek-ai/dsh-session-projection')
const {LlmRuntime}=await import('@deepseek-ai/dsh-llm')
const {ToolRuntime}=await import('@deepseek-ai/dsh-tools')
const {SystemPrompt}=await import('@deepseek-ai/dsh-system-prompt')
const {AgentLoop}=await import('@deepseek-ai/dsh-agent-loop')
const {LocalJobRegistry}=await import('@deepseek-ai/dsh-jobs-local')
const jsonl=await import('@deepseek-ai/dsh-session-persistence-jsonl')
const nativeCleaner=await import('../src/native-cleaner/plugin.mjs')
const {RetirementStore}=await import('../src/native-cleaner/retirement-store.mjs')
const {ExactJsonlAdapter,sessionDirectory}=await import('../src/native-cleaner/jsonl-adapter.mjs')
const {FrameworkRoleRuntime}=await import('../src/framework/role-runtime.ts')
const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {GitFiles,withSnapshot}=await import('../src/framework/transactions.ts')
const {GitAuthorityStore,SessionGitOperations}=await import('../src/framework/git-authority.ts')
const {installFrameworkRoleTools,workerPaths}=await import('../src/framework/role-tools.ts')
const {paths,taskInitializationFiles}=await import('../src/framework/task-files.ts')
const {observeCleanup}=await import('../src/framework/cleaner.ts')
const {workerTransferPath}=await import('../src/framework/worker-business.ts')
const {Repository,put,head}=await import('./test-support/controlled-git/repository.mjs')
const hash=v=>createHash('sha256').update(v).digest('hex'),clone=structuredClone
const root=process.env.DSS_WORKER_EVIDENCE_ROOT??await fs.mkdtemp('/tmp/dss-worker-native-')
// Preserve explicitly requested evidence; remove only this test's own default temporary directory.
if(!process.env.DSS_WORKER_EVIDENCE_ROOT)process.once('exit',()=>rmSync(root,{recursive:true,force:true}))
const expectEarly=process.env.DSS_EXPECT_WORKER_RETIREMENT!=='0'
const checks=[],scenarios=[],trace=[]
const check=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);checks.push(name)}
const tick=()=>new Promise(setImmediate),defer=()=>Promise.withResolvers()
const faults=new Map(),heldCleanups=new Map(),acceptCounts=new Map(),allFixtures=[]
const accept=RetirementStore.prototype.accept,cleanup=ExactJsonlAdapter.prototype.cleanup
RetirementStore.prototype.accept=async function(lives,verify){
 for(const life of lives){trace.push(['journal-attempt',life.id]);acceptCounts.set(life.id,(acceptCounts.get(life.id)??0)+1);const fault=faults.get(life.id);if(fault){if(fault.once)faults.delete(life.id);if(fault.ready)fault.ready.resolve();if(fault.wait)await fault.wait;if(fault.error)throw fault.error}}
 const result=await accept.call(this,lives,verify);for(const life of lives)trace.push(['journal-accepted',life.id]);return result
}
ExactJsonlAdapter.prototype.cleanup=async function(life){const hold=heldCleanups.get(life.id);if(hold){hold.ready.resolve();await hold.wait}trace.push(['physical-cleanup',life.id]);return cleanup.call(this,life)}
async function settle(rt,{native=true}={}){
 for(;;){const pending=[...rt.workerDrains?.values()??[],...rt.nativeRetirementOperations?.values()??[],...rt.roleWrites?.values()??[],...rt.maintenance?.values()??[]];if(!pending.length)break;await Promise.allSettled(pending);await tick()}
 if(native)await rt.ctx.get('nativeSessionCleaner').drain()
}
const read=(f,p)=>withSnapshot(f.files,s=>f.files.read(s,p))
async function fixture(mode,name,reopen){
 const dir=path.join(root,name),sdk=await openDshStorageFixture(path.join(dir,'storage'),path.join(dir,'locator'))
 new AgentRegistry(sdk.ctx);new SessionStore(sdk.ctx);new SessionProjectionRegistry(sdk.ctx);new LlmRuntime(sdk.ctx);new SystemPrompt(sdk.ctx,{});new ToolRuntime(sdk.ctx);new LocalJobRegistry(sdk.ctx,{})
 const plugin=sdk.ctx.plugin(jsonl,{root:path.join(dir,'sessions'),compression:'none'});await plugin.await()
 new AgentLoop(sdk.ctx,{agents:[],maxParallelToolCalls:10})
 await nativeCleaner.apply(sdk.ctx,{}, {onFailure(error,stage){throw new Error(stage,{cause:error})}})
 const repo=mode==='git'?(reopen?.repo??new Repository()):undefined;if(repo&&!reopen)head(repo)
 if(repo&&!reopen){const commit=repo.commitPrepared.bind(repo);repo.commitPrepared=async(snapshot,changes,message,operation)=>{const result=await commit(snapshot,changes,message,operation);if(!result.replay){for(const change of changes)if(change.deleteTree)for(const target of repo.bodies.keys())if(target.startsWith(change.path+'/'))repo.bodies.delete(target);repo.history.set(repo.head,new Map(repo.bodies))}return result}}
 const files=repo?new GitFiles(repo,new SessionGitOperations()):new PhysicalLocalFiles(path.join(dir,'business'))
 const records=repo?new GitAuthorityStore(files,name+'-authority'):sdk.adapter
 const errors=[],config={scope:name,mode,member:'A',primary:true,workspace:dir,workerSeats:4,collaborationId:'fixture',instanceUUID:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}
 const rt=new FrameworkRoleRuntime(sdk.ctx,files,records,config,{members:()=>['A'],resources:()=>[],heartbeat:async()=>{},error:(e,c)=>{errors.push({message:String(e),context:c});return true}})
 const f={dir,sdk,plugin,repo,files,records,rt,errors,mode,name,closed:false,prefix:'framework-runtime/'+hash(name)+'/',
  async write(p,v){if(repo){put(repo,p,v);head(repo)}else await files.replace(p,v)},
  async close(){if(f.closed)return;f.closed=true;await rt.loop.stop();await settle(rt);await plugin.dispose();await sdk.close();await files.close?.()}}
 allFixtures.push(f);return f
}
async function worker(f,label,{role='Worker',task:existingTask,workerId='worker'}={}){
 const taskId=existingTask?.taskId??'10000000-0000-4000-8000-'+hash(label).slice(0,12),workId=f.rt.roleKey(role,taskId,role==='Worker'?workerId:undefined)
 const task=existingTask??{version:1,taskId,route:'P',owner:'A',members:['A'],status:'running',sourcePath:'tasks/'+label+'_P.md',archiveFolder:taskId}
 if(!existingTask){await f.write(paths.task(taskId),JSON.stringify(task));await f.write(task.sourcePath,'Original actual task '+label)
 for(const change of taskInitializationFiles(task))await f.write(change.path,change.content)}
 const record={identity:{role,workId,executionId:label+'-execution',taskId,member:'A',...(role==='Worker'?{workerId}:{})},sessionId:label+'-native-session',generation:1,lastWake:{id:label+'-wake',role,taskId,workerId,reason:'state',sources:[]}}
 const key=f.prefix+'roles/'+hash(workId),retiredKey=f.prefix+'retired-workers/'+record.identity.executionId
 await f.records.set(key,record);f.rt.roleRecords.set(workId,clone(record));(f.rt.roleBases??=new Map()).set(workId,clone(record))
 const binding={...record.identity,generation:1,owner:'A'},w=workerPaths(taskId,'A',workerId)
 if(role==='Worker'){await f.write(w.contract,'Original accepted Worker contract');await f.write(w.reply,'');await f.write(w.notes,'Original note')}
 let ended=0
 const owned=await f.rt.native.open(record.identity,{sessionId:record.sessionId,cwd:f.dir,setup:(ctx,agent)=>installFrameworkRoleTools(ctx,agent,binding,f.rt.services())})
 const agent=owned.actualAgent
 agent.session.append('user/message',{id:label+'-native-input',role:'user',content:[{type:'text',text:'Original accepted task '+label}],source:{kind:'deepseek-servant'}},{surfaceOp:'append'})
 await f.sdk.ctx.sessions.flush(agent.session)
 const nativeFile=path.join(sessionDirectory(path.join(f.dir,'sessions'),agent.session.header),'session.v'+agent.session.header.version+'.jsonl')
 const bytes=await fs.readFile(nativeFile)
 check(label+' precondition materialized native bytes',bytes.length>0,true)
 check(label+' precondition exact native stat identity',(await f.sdk.ctx.sessionPersistence.stat(record.sessionId)).header.id,record.sessionId)
 await fs.writeFile(path.join(f.dir,label+'-native-before.jsonl'),bytes)
 trace.push(['native-before',record.sessionId,nativeFile,hash(bytes),bytes.length])
 const call=async(name,input,id=name)=>{const tool=f.sdk.ctx.tools.get(name,agent);assert(tool,'Actual SDK registration '+name);return tool.execute(input,{agent,callId:id,signal:new AbortController().signal,concludeTurn(){ended++}})}
 const view=await call('dss_snapshot',{}),marker=workerTransferPath(f.rt.workerBusinessScope(),record.identity.executionId)
 const transfer=kind=>call('dss_worker_'+kind,{snapshotId:view.snapshotId,reply:'Actual reply '+label,records:[{path:w.records+'result.md',text:'Actual record '+label}],handoff:'Actual handoff',...(kind==='relay'?{successorId:'next',contract:'Next actual contract'}:{})},label+'-call')
 return{task,record,key,retiredKey,binding,w,owned,agent,call,view,marker,transfer,get ended(){return ended},nativeFile,present:async()=>fs.access(nativeFile).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error})}
}
async function run(mode,name,fn){const start=checks.length;let f;try{f=await fixture(mode,mode+'-'+name);await fn(f);scenarios.push({mode,name,status:'passed',checks:checks.length-start})}catch(error){scenarios.push({mode,name,status:'failed',checks:checks.length-start,error:String(error),stack:error.stack});console.error(name,error)}finally{if(f)await f.close()}}
if(process.env.DSS_WORKER_HARNESS_ONLY!=='1')try{
 for(const mode of ['local','git'])for(const kind of ['relay','deliver'])await run(mode,'normal-'+kind,async f=>{
  const w=await worker(f,f.name);check(f.name+' idle is not native retire',acceptCounts.get(w.record.sessionId)??0,0)
  const untouched=await worker(f,f.name+'-untouched'),untouchedBytes=await fs.readFile(untouched.nativeFile)
  await w.transfer(kind);check(f.name+' tool concluded without Task completion',w.ended,1);await settle(f.rt)
  const retired=await f.records.get(w.retiredKey)
  check(f.name+' original stopped fact',retired.stopped,true);check(f.name+' producer disposed',retired.stopIntent.phase,'disposed')
  check(f.name+' Task still running',JSON.parse(await read(f,paths.task(w.task.taskId))).status,'running')
  check(f.name+' transfer retained',!!await read(f,w.marker),true);check(f.name+' native log removed before Task',await w.present(),!expectEarly)
  check(f.name+' no pending after accepted',retired.nativeRetirements??[],[])
  const before=acceptCounts.get(w.record.sessionId)??0;await f.rt.loop.observeLocal();await settle(f.rt);check(f.name+' repeated existing observation does not reaccept',acceptCounts.get(w.record.sessionId)??0,before)
  check(f.name+' no long lived retirement promise',f.rt.nativeRetirementOperations?.size??0,0)
  check(f.name+' unrelated materialized Session remains byte-identical',await fs.readFile(untouched.nativeFile),untouchedBytes)
  check(f.name+' no error',f.errors,[])
 })
 if(expectEarly && process.env.DSS_NORMAL_ONLY!=='1'){
 for(const mode of ['local','git'])await run(mode,'journal-failure-existing-observation',async f=>{
  const w=await worker(f,f.name),id=w.record.sessionId
  faults.set(id,{error:new Error('CONTROLLED: journal acceptance unavailable')})
  await w.transfer('relay');await settle(f.rt)
  check(f.name+' accepted business not blocked by journal failure',w.ended,1)
  let row=await f.records.get(w.retiredKey)
  check(f.name+' stopped does not depend on Cleaner ACK',row.stopped,true)
  check(f.name+' exact original pending retained',row.nativeRetirements,[{sessionId:id,executionId:w.record.identity.executionId}])
  check(f.name+' unaccepted native remains',await w.present(),true)
  const other=await worker(f,f.name+'-independent');await other.transfer('deliver');await settle(f.rt)
  check(f.name+' unrelated Worker accepts and deletes independently',await other.present(),false)
  check(f.name+' original pending not duplicated', (await f.records.get(w.retiredKey)).nativeRetirements.length,1)
  faults.delete(id);await f.rt.loop.observeLocal();await settle(f.rt)
  row=await f.records.get(w.retiredKey);check(f.name+' existing Host observation retries acceptance',acceptCounts.get(id),2)
  check(f.name+' pending removed without success receipt',Object.hasOwn(row,'nativeRetirements'),false)
  check(f.name+' transfer still retained',!!await read(f,w.marker),true)
  check(f.name+' original native removed after accepted retry',await w.present(),false)
  const fields=Object.keys(row).filter(x=>/retir|accept|clean/i.test(x));check(f.name+' no new receipt field',fields,[])
  const before=acceptCounts.get(id);await f.rt.loop.observeLocal();await settle(f.rt);check(f.name+' no completed per-tick lookup',acceptCounts.get(id),before)
 })
 for(const mode of ['local','git'])await run(mode,'accepted-not-physical-delete',async f=>{
  const w=await worker(f,f.name),ready=defer(),gate=defer(),id=w.record.sessionId;heldCleanups.set(id,{ready,wait:gate.promise})
  try{
   await w.transfer('deliver');await ready.promise;await settle(f.rt,{native:false})
   check(f.name+' original pending clears at durable acceptance',(await f.records.get(w.retiredKey)).nativeRetirements,undefined)
   check(f.name+' physical log can remain after API success',await w.present(),true)
   const journal=new RetirementStore(path.join(f.dir,'storage/native-session-cleaner'),path.join(f.dir,'sessions'))
   check(f.name+' original journal retains unfinished physical duty',(await journal.accepted()).map(r=>r.header.id),[id])
   const other=await worker(f,f.name+'-other',{task:w.task,workerId:'next'});await other.transfer('relay');await settle(f.rt,{native:false})
   check(f.name+' same Task next actual Worker tool returned while cleanup held',other.ended,1)
   const planner=await worker(f,f.name+'-planner',{task:w.task,role:'Planner'})
   check(f.name+' same Task actual Planner native admission succeeds while cleanup held',f.rt.native.get(planner.record.identity.workId)?.sessionId,planner.record.sessionId)
  }finally{gate.resolve();heldCleanups.delete(id)}
  await settle(f.rt);check(f.name+' physical cleanup independently finishes',await w.present(),false)
 })
 await run('local','producer-close-not-yet-stopped',async f=>{
  const w=await worker(f,f.name),id=w.record.sessionId,ready=defer(),gate=defer(),dispose=w.owned.dispose.bind(w.owned)
  w.owned.dispose=async()=>{ready.resolve();await gate.promise;return dispose()}
  try{
   await w.transfer('relay');await ready.promise
   check(f.name+' transfer publishes without native stop wait',w.ended,1)
   check(f.name+' closing is not stopped',!!(await f.records.get(w.retiredKey)).stopped,false)
   check(f.name+' closing is not native acceptance',acceptCounts.get(id)??0,0)
   const other=await worker(f,f.name+'-other');await other.transfer('deliver');await Promise.all([...f.rt.workerDrains].filter(([key])=>key!==w.record.identity.executionId).map(([,p])=>p))
   check(f.name+' unrelated actual Worker completes while old close held',other.ended,1)
  }finally{gate.resolve()}
  await settle(f.rt);check(f.name+' true native stop later owns exact retirement',await w.present(),false)
 })
 await run('local','producer-stop-unknown',async f=>{
  const w=await worker(f,f.name),done=defer();f.sdk.ctx.jobs.attachController('test-owned-producer')
  f.sdk.ctx.jobs.start({owner:w.agent.id,kind:'fixture',label:'explicit producer cancellation failure',run(){return{done:done.promise,cancel(){throw Error('CONTROLLED producer cancel failure')}}}})
  await w.transfer('deliver');await settle(f.rt)
  const row=await f.records.get(w.retiredKey)
  check(f.name+' actual failed producer remains unknown',!!row.stopUnknown,true)
  check(f.name+' unknown not promoted to stopped',!!row.stopped,false)
  check(f.name+' unknown retains original pending without dispatch',row.nativeRetirements,[{sessionId:w.record.sessionId,executionId:w.record.identity.executionId}])
  check(f.name+' unknown never called cleaner',acceptCounts.get(w.record.sessionId)??0,0)
  check(f.name+' unknown native evidence retained',await w.present(),true)
  done.resolve({status:'failed',detail:'test end after forced settlement'})
 })
 await run('local','prepared-publication-independent',async f=>{
  const w=await worker(f,f.name),rename=f.files.rename.bind(f.files),marker=w.marker
  f.files.rename=async(a,b)=>{if(b===w.w.reply)throw Error('CONTROLLED: after accepted prepared marker, before reply rename');return rename(a,b)}
  await assert.rejects(w.transfer('relay'),/after accepted prepared marker/);checks.push(f.name+' actual installed tool failed after acceptance')
  check(f.name+' marker owns accepted original bytes',!!JSON.parse(await read(f,marker)).physical,true)
  check(f.name+' publication incomplete',JSON.parse(await read(f,marker)).physical.published,undefined)
  await f.rt.reconcileWorkerTransfers(false);await settle(f.rt)
  check(f.name+' accepted business transfer drains actual producer', (await f.records.get(w.retiredKey)).stopped,true)
  check(f.name+' no artificial publication completion gate',await w.present(),false)
  check(f.name+' accepted original staged responsibility retained',JSON.parse(await read(f,marker)).physical.published,undefined)
  f.files.rename=rename;await f.rt.reconcileWorkerTransfers(false);await settle(f.rt)
  check(f.name+' original resume publishes without old Session',JSON.parse(await read(f,marker)).physical.published,true)
  check(f.name+' exact original result preserved',await read(f,w.w.reply),'Actual reply '+f.name)
  check(f.name+' original contract preserved',await read(f,workerPaths(w.task.taskId,'A','next').contract),'Next actual contract')
 })
 for(const mode of ['local','git'])await run(mode,'cold-existing-pending',async f=>{
  const w=await worker(f,f.name),id=w.record.sessionId
  faults.set(id,{error:new Error('CONTROLLED: fail before cold restart journal acceptance')})
  await w.transfer('relay');await settle(f.rt)
  check(f.name+' cold source pending durably saved',(await f.records.get(w.retiredKey)).nativeRetirements.length,1)
  const repo=f.repo;await f.close();faults.delete(id)
  const cold=await fixture(mode,f.name,{repo})
  try{
   // Full production startup loading and reconciliation. Only new business
   // admissions at the original Host wake port are observed, not dispatched to a model.
   cold.rt.loop.actions.wake=async request=>{trace.push(['cold-observed-wake',request.role]);return false}
   await cold.rt.start();await cold.rt.loop.stop();await settle(cold.rt)
   const row=await cold.records.get(w.retiredKey)
   check(f.name+' startup continues exact pending row',row.nativeRetirements,undefined)
   check(f.name+' cold stop fact retained',row.stopped,true)
   check(f.name+' cold log removed',!!await cold.sdk.ctx.sessionPersistence.stat(id),false)
   check(f.name+' cold transfer remains authoritative',!!await read(cold,w.marker),true)
   check(f.name+' no wrong role recreation',cold.rt.roleRecords.get(w.record.identity.workId).businessTransferred,true)
  }finally{await cold.close()}
 })
 for(const mode of ['local','git'])await run(mode,'task-release-during-acceptance',async f=>{
  const w=await worker(f,f.name),id=w.record.sessionId,ready=defer(),gate=defer()
  faults.set(id,{ready,wait:gate.promise})
  try{
   await w.transfer('deliver');await ready.promise
   check(f.name+' accepted original pending before final release',(await f.records.get(w.retiredKey)).nativeRetirements.length,1)
   const task={...w.task,status:'complete'};await f.write(paths.task(task.taskId),JSON.stringify(task))
   if(mode==='git'){
    await f.write(paths.state('A',task.taskId)+'/Cleaner','')
    await withSnapshot(f.files,async snapshot=>{const observation=await observeCleanup(f.files,snapshot,task,performance.now());check(f.name+' existing fixed cleanup observed',observation.status,'delete');await f.rt.cleaner.clean(task,observation)})
   }
   const releasing=f.rt.loop.actions.releaseTask(task.taskId,task.lifecycleId,task);releasing.catch(()=>{})
   await tick();gate.resolve();faults.delete(id)
   await releasing;await settle(f.rt)
   check(f.name+' final release removes original transfer',await read(f,w.marker),undefined)
   check(f.name+' final release removes original retired row',await f.records.get(w.retiredKey),undefined)
   check(f.name+' independent pending clear did not resurrect row',f.rt.retiredWorkers.has(w.record.identity.executionId),false)
   check(f.name+' original native removed',await w.present(),false)
  }finally{gate.resolve();faults.delete(id)}
 })
 }
 const result={status:scenarios.every(s=>s.status==='passed')?'passed':'failed',expectEarly,checks:checks.length,checkNames:checks,scenarios,trace,...evidence(),limits:'Actual installed SDK AgentLoop, tool registry, native persistence, Cleaner kernel locks/SQLite, full Runtime constructor and original Host observe entry. Tool invocation and initial admitted role metadata are controlled inputs, not a model turn. Git remote transport controlled. No external service, Windows or production acceptance claim.',root}
 console.log(JSON.stringify(result,null,2));await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2));if(result.status!=='passed')process.exitCode=1
}finally{RetirementStore.prototype.accept=accept;ExactJsonlAdapter.prototype.cleanup=cleanup}

export {fixture,worker,settle,read,check,checks,trace,faults,heldCleanups,acceptCounts,root}
