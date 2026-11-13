import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {rmSync} from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {evidence} from './test-support/dsh-sdk-runtime.mjs'
import {openDshStorageFixture} from './test-support/dsh-sdk-storage.mjs'
const {AgentRegistry}=await import('@deepseek-ai/dsh-agent'),{SessionStore}=await import('@deepseek-ai/dsh-session'),{SessionProjectionRegistry}=await import('@deepseek-ai/dsh-session-projection')
const {LlmRuntime,LlmAdapter}=await import('@deepseek-ai/dsh-llm'),{ToolRuntime}=await import('@deepseek-ai/dsh-tools'),{SystemPrompt}=await import('@deepseek-ai/dsh-system-prompt'),{AgentLoop}=await import('@deepseek-ai/dsh-agent-loop')
const {LocalJobRegistry}=await import('@deepseek-ai/dsh-jobs-local'),{WorkspaceRegistry}=await import('@deepseek-ai/dsh-workspace'),{LocalFileSystem}=await import('@deepseek-ai/dsh-fs-local'),{WorkingDirectoryService}=await import('@deepseek-ai/dsh-working-directory')
const jsonl=await import('@deepseek-ai/dsh-session-persistence-jsonl'),cleaner=await import('../src/native-cleaner/plugin.mjs')
const {RetirementStore}=await import('../src/native-cleaner/retirement-store.mjs'),{NativeCleanerCoordinator}=await import('../src/native-cleaner/coordinator.mjs'),{ExactJsonlAdapter,sessionDirectory}=await import('../src/native-cleaner/jsonl-adapter.mjs')
const originalSessionGet=SessionStore.prototype.get
SessionStore.prototype.get=function(id){const value=originalSessionGet.call(this,id),caller=new Error().stack;if(caller.includes('/framework/role-runtime.ts:'))mark('recovery-header-get',{id,present:!!value,cwd:value?.header.cwd,caller});return value}
const {DshStorageAdapter}=await import('../src/adapters/dsh/storage.ts')
const storageSet=DshStorageAdapter.prototype.set
DshStorageAdapter.prototype.set=async function(key,value){const r=await storageSet.call(this,key,value);if(value?.identity?.role)mark('role-persisted',{key,record:value});return r}
const {FrameworkService}=await import('../src/framework/service.ts')
const root=process.env.DSS_PO_NATIVE_ROOT??await fs.mkdtemp('/tmp/dss-po-native-'),scenario=process.env.DSS_PO_NATIVE_CASE??'failure',script=await fs.readFile(new URL(import.meta.url),'utf8')
if(!process.env.DSS_PO_NATIVE_ROOT)process.once('exit',()=>rmSync(root,{recursive:true,force:true}))
await fs.mkdir(root,{recursive:true});const trace=[],checks=[],faults=new Map(),physicalHolds=new Map(),results=new Map(),lastResults=new Map(),fixtures=[]
const hash=x=>createHash('sha256').update(x).digest('hex'),defer=()=>Promise.withResolvers(),mark=(event,data={})=>{trace.push({event,...data});console.log(event,JSON.stringify(data))}
const check=(name,a,b)=>{assert.deepEqual(a,b,name);checks.push(name)}
async function until(name,fn){const end=Date.now()+20000;while(true){const r=await fn();if(r)return r;if(Date.now()>end)throw Error('Experiment wait expired: '+name);await new Promise(r=>setTimeout(r,10))}}
const accept=RetirementStore.prototype.accept,cleanup=ExactJsonlAdapter.prototype.cleanup,retire=NativeCleanerCoordinator.prototype.retire
NativeCleanerCoordinator.prototype.retire=function(id){mark('retire',{id});return retire.call(this,id)}
RetirementStore.prototype.accept=async function(lives,verify){for(const l of lives){mark('accept-attempt',{id:l.id});const fault=faults.get(l.id);if(fault){fault.entered?.resolve();if(fault.wait)await fault.wait;if(fault.error)throw fault.error}}const r=await accept.call(this,lives,verify);for(const l of lives)mark('accepted',{id:l.id});return r}
ExactJsonlAdapter.prototype.cleanup=async function(life){const h=physicalHolds.get(life.id);if(h){h.entered.resolve();await h.wait}mark('physical',{id:life.id});return cleanup.call(this,life)}
function tool(name,input,id,index=0){return [{type:'tool-call-delta',index,name,id,argumentsDelta:JSON.stringify(input)},{type:'finish',reason:'tool-calls'}]}
class Model extends LlmAdapter{
 calls=[];claimed=new Set();waiting=new Map();nextRestore;foregroundDone=new Set(); finishing=new Map()
 async *stream(o){this.calls.push(o);mark('model',{id:o.sessionId,call:this.calls.length});const supports=n=>o.tools.some(t=>t.name===n)
  if(supports('dss_task_restore')&&!this.claimed.has(o.sessionId)){this.claimed.add(o.sessionId);yield*tool('dss_claim',{},'foreground-claim-'+this.calls.length);return}
  if(this.nextRestore&&supports('dss_task_restore')){const p=this.nextRestore;this.nextRestore=undefined;this.foregroundDone.add(o.sessionId);yield*tool('dss_task_restore',p,'restore-'+this.calls.length);return}
  if(supports('dss_task_restore')||this.foregroundDone.has(o.sessionId)){yield{type:'text-delta',index:0,text:'Request arranged.'};yield{type:'finish',reason:'stop'};return}
  if(!this.claimed.has(o.sessionId)&&['dss_worker_assign','dss_planner_dispatch','dss_recorder_save','dss_restore'].some(supports)){this.claimed.add(o.sessionId);yield*tool('dss_claim',{},'claim-'+this.calls.length);return}
  if(this.finishing.has(o.sessionId)){
   const action=this.finishing.get(o.sessionId),last=lastResults.get(o.sessionId),v=results.get(o.sessionId)
   if(last?.completed===false||last?.saved===false){yield*tool('dss_claim',{},'reclaim-'+this.calls.length);return}
   if(last?.snapshotId){if(action==='complete')yield*tool('dss_complete',{snapshotId:v.snapshotId,acceptance:'Actual isolated acceptance after processing current notifications.',resultPaths:[]},'complete-retry-'+this.calls.length);else yield*tool('dss_recorder_save',{snapshotId:v.snapshotId,outputs:[{path:v.archiveRecordsPath,text:'# Actual retained outcome'}],retainedPaths:[]},'archive-retry-'+this.calls.length);return}
  }
  yield{type:'text-delta',index:0,text:'Actual isolated model progress.'}
  const d=defer();this.waiting.set(o.sessionId,d)
  const abort=()=>d.reject(o.signal.reason);o.signal.addEventListener('abort',abort,{once:true});if(o.signal.aborted)abort()
  let action;try{action=await d.promise}finally{o.signal.removeEventListener('abort',abort);this.waiting.delete(o.sessionId)}
  if(action==='idle'){yield{type:'finish',reason:'stop'};return}
  if(typeof action==='object'){yield*tool(action.name,action.input,'controlled-'+this.calls.length,1);return}
  const v=results.get(o.sessionId);assert(v?.snapshotId,'Actual claim result required for later model tool')
  this.finishing.set(o.sessionId,action)
  if(action==='complete')yield*tool('dss_complete',{snapshotId:v.snapshotId,acceptance:'Actual isolated acceptance of the requested test objective.',resultPaths:[]},'complete-'+this.calls.length,1)
  else if(action==='archive')yield*tool('dss_recorder_save',{snapshotId:v.snapshotId,outputs:[{path:v.archiveRecordsPath,text:'# Retained actual task outcome\nCompleted isolated task and retained original result.'}],retainedPaths:[]},'archive-'+this.calls.length,1)
 }
 command(id,action){const d=this.waiting.get(id);assert(d,'Actual model must be waiting');d.resolve(action)}
}
async function fixture(name='fixture',reopen=false){const dir=path.join(root,name);await fs.mkdir(path.join(dir,'workspace'),{recursive:true});const sdk=await openDshStorageFixture(path.join(dir,'storage'),path.join(dir,'locator'))
 new AgentRegistry(sdk.ctx);new SessionStore(sdk.ctx);new SessionProjectionRegistry(sdk.ctx);new LlmRuntime(sdk.ctx);new SystemPrompt(sdk.ctx,{});new ToolRuntime(sdk.ctx);new LocalJobRegistry(sdk.ctx,{})
 const jp=sdk.ctx.plugin(jsonl,{root:path.join(dir,'sessions'),compression:'none'});await jp.await()
 new LocalFileSystem(sdk.ctx,{cwd:path.join(dir,'workspace'),diffBasisMaxBytes:1048576});new WorkingDirectoryService(sdk.ctx,{defaultDirectory:path.join(dir,'workspace')});const wp=sdk.ctx.plugin(WorkspaceRegistry);await wp.await();const lp=sdk.ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:10});await lp.await()
 const model=new Model();sdk.ctx.llm.registerAdapter(['isolated-wire'],model)
 sdk.ctx.on('session/event',(session,event)=>{if(['tool/call','tool/result'].includes(event.type)){mark('tool',{id:session.header.id,type:event.type,data:event.data});if(event.type==='tool/result'&&!event.data.message.isError){for(const c of event.data.message.content??[])if(c.type==='text'){try{const v=JSON.parse(c.text);lastResults.set(session.header.id,v);if(v.snapshotId)results.set(session.header.id,v)}catch{}}}}})
 await cleaner.apply(sdk.ctx,{}, {onFailure(e,stage){throw Error(stage,{cause:e})}})
 const rawOpen=sdk.ctx.sessionPersistence.open.bind(sdk.ctx.sessionPersistence)
 sdk.ctx.sessionPersistence.open=async function(id,mode){mark('native-open',{id,mode,caller:new Error().stack});const h=await rawOpen(id,mode),close=h.close.bind(h);h.close=async()=>{const r=await close();mark('native-handle-closed',{id,mode});return r};return h}
 const service=new FrameworkService(sdk.ctx,sdk.adapter,{name:'PO native evidence',userName:'Evidence',localDirectory:path.join(dir,'business'),ownerRepo:'',repositoryDirectory:path.join(dir,'unused-git'),collaborationId:'po-native',workerSeats:1,workspace:path.join(dir,'workspace'),foreground:{provider:'isolated-wire',model:'controlled'},background:{provider:'isolated-wire',model:'controlled'}})
 await service.start();const active=service.running.get('local');assert(active,'Actual Service startup');const rt=active.runtime,prefix='framework-runtime/'+hash(active.connection.scope)+'/'
 const f={dir,sdk,jp,model,service,active,rt,prefix,closed:false,
  row:r=>active.connection.records.get(prefix+'roles/'+hash(r.identity.workId)),
  file:r=>path.join(sessionDirectory(path.join(dir,'sessions'),{...sdk.ctx.sessions.get(r.sessionId)?.header,id:r.sessionId}), 'session.v4.jsonl'),
  async close(){if(f.closed)return;f.closed=true;await service.dispose();await Promise.allSettled(rt.nativeRetirementOperations?.values()??[]);await sdk.ctx.get('nativeSessionCleaner').drain();await jp.dispose();await sdk.close()}}
 fixtures.push(f);mark('fixture',{dir,reopen,scope:active.connection.scope});return f
}
async function task(f,route,label){const src='tasks/'+label+'_'+route+'.md';await fs.mkdir(path.join(f.dir,'business','tasks'),{recursive:true});await fs.writeFile(path.join(f.dir,'business',src),'# Original isolated '+label+'\nOne finite objective, held by the deterministic model until the test releases it.\n')
 const role=route==='P'?'Planner':'Organizer',row=await until('actual '+label+' claim',()=>[...f.rt.roleRecords.values()].find(r=>r.identity.role===role&&r.taskWorkspace?.folder.startsWith(label+'_')&&f.model.waiting.has(r.sessionId)))
 const copy=structuredClone(row),agent=f.rt.native.get(row.identity.workId).actualAgent;await f.sdk.ctx.sessions.flush(agent.session)
 const file=path.join(sessionDirectory(path.join(f.dir,'sessions'),agent.session.header),'session.v'+agent.session.header.version+'.jsonl'),bytes=await fs.readFile(file);check(label+' actual original nonempty',bytes.length>0,true);check(label+' real claim recorded',bytes.toString().includes('dss_claim'),true)
 await fs.writeFile(path.join(root,label+'-before.jsonl'),bytes);mark('original',{label,record:copy,file,bytes:bytes.length,sha256:hash(bytes)})
 return{...copy,file,label}
}
async function pause(f,r,label){await f.service.taskControl({mode:'local',storageScope:f.active.connection.scope,taskId:r.identity.taskId,...r.identity.lifecycleId?{lifecycleId:r.identity.lifecycleId}:{},commandId:label,intent:'paused'})
 const stopped=await until('actual stopped '+label,()=>{const n=f.rt.roleRecords.get(r.identity.workId);return n?.stopped&&n.identity.executionId===r.identity.executionId?n:undefined});check(label+' exact native gone',f.rt.native.get(r.identity.workId),undefined);mark('stopped',{record:stopped});return structuredClone(stopped)}
async function resume(f,r,label){await f.service.taskControl({mode:'local',storageScope:f.active.connection.scope,taskId:r.identity.taskId,...r.identity.lifecycleId?{lifecycleId:r.identity.lifecycleId}:{},commandId:label,intent:'running'})
 const next=await until('actual new '+label,()=>{const n=f.rt.roleRecords.get(r.identity.workId);return n&&n.sessionId!==r.sessionId&&f.model.waiting.has(n.sessionId)?n:undefined});mark('replacement',{old:r.sessionId,record:next});return structuredClone(next)}
async function missing(file){return fs.access(file).then(()=>false,e=>{if(e.code==='ENOENT')return true;throw e})}
async function pendingCleared(f,r){await until('pending cleared',async()=>!(await f.row(r))?.nativeRetirements?.length)}
async function finish(f,r){f.model.command(r.sessionId,'complete');await until('actual Task complete',async()=>JSON.parse(await fs.readFile(path.join(f.dir,'business','tasks',r.identity.taskId+'.json'),'utf8')).status==='complete')
 const recorder=await until('actual Recorder claim',()=>[...f.rt.roleRecords.values()].find(x=>x.identity.role==='Recorder'&&x.identity.taskId===r.identity.taskId&&f.model.waiting.has(x.sessionId)));f.model.command(recorder.sessionId,'archive');return recorder}
let f
if(process.env.DSS_PO_NATIVE_HARNESS!=='1')try{
 if(scenario==='failure'){
  f=await fixture();const old=await task(f,'P','failed-accept');await pause(f,old,'pause-a');faults.set(old.sessionId,{error:Error('CONTROLLED journal acceptance failure')});const next=await resume(f,old,'resume-a')
  await until('actual accept attempted',()=>trace.some(e=>e.event==='accept-attempt'&&e.id===old.sessionId));const row=await f.row(next);check('original pending retained',row.nativeRetirements,[{sessionId:old.sessionId,executionId:old.identity.executionId}]);check('unaccepted original file retained',await missing(old.file),false)
  const other=await task(f,'O','independent');check('unrelated actual model starts while failure retained',f.model.waiting.has(other.sessionId),true)
  await pause(f,next,'pause-after-failure');faults.delete(old.sessionId);const third=await resume(f,next,'resume-after-failure');await pendingCleared(f,third);await f.sdk.ctx.get('nativeSessionCleaner').drain();check('existing save continuation accepts old exact',await missing(old.file),true);check('no success receipt',(await f.row(third)).nativeRetirements,undefined);check('unrelated still owns actual native',!!f.rt.native.get(other.identity.workId),true)
 }else if(scenario==='held-accept'||scenario==='held-physical'){
  f=await fixture();const old=await task(f,'O','held');await pause(f,old,'pause-held');const gate=defer(),entered=defer();if(scenario==='held-accept')faults.set(old.sessionId,{wait:gate.promise,entered});else physicalHolds.set(old.sessionId,{wait:gate.promise,entered})
  try{const next=await resume(f,old,'resume-held');await entered.promise;check('next actual model did not wait Cleaner',f.model.waiting.has(next.sessionId),true);const other=await task(f,'P','independent');check('unrelated actual model did not wait Cleaner',f.model.waiting.has(other.sessionId),true);const independent=await fixture('independent-host');const external=await task(independent,'O','other-host');check('independent real Host starts while original cleanup held',independent.model.waiting.has(external.sessionId),true);check('physical old still exists while held',await missing(old.file),false);if(scenario==='held-physical'){await pendingCleared(f,next);check('pending clears before physical deletion',(await f.row(next)).nativeRetirements,undefined)}}finally{gate.resolve();faults.delete(old.sessionId);physicalHolds.delete(old.sessionId)}await until('old physical removal',()=>missing(old.file))
 }else if(scenario==='release-failure'){
  f=await fixture();const old=await task(f,'P','release');await pause(f,old,'pause-release');faults.set(old.sessionId,{error:Error('CONTROLLED accepted journal unavailable through final release')});const next=await resume(f,old,'resume-release');const recorder=await finish(f,next)
  const released=await until('actual released record retained',async()=>{const r=await f.row(next);return r?.released?r:undefined});check('released compact preserves exact old pending',released.nativeRetirements,[{sessionId:old.sessionId,executionId:old.identity.executionId}]);check('failure cannot discard original role row',!!await f.row(next),true);check('failed old file retained',await missing(old.file),false)
  const other=await task(f,'O','release-independent');check('unrelated Task starts despite final release failure',f.model.waiting.has(other.sessionId),true)
  faults.delete(old.sessionId);await until('existing Task release retries and removes row',async()=>!await f.row(next));await f.sdk.ctx.get('nativeSessionCleaner').drain();check('pending original eventually removed',await missing(old.file),true);check('long-term archive retained',(await fs.readdir(path.join(f.dir,'business','archives'))).length>0,true)
 }else if(scenario==='release-overlap'){
  f=await fixture();const old=await task(f,'O','release-overlap');await pause(f,old,'pause-overlap');const gate=defer(),entered=defer();faults.set(old.sessionId,{wait:gate.promise,entered})
  try{const next=await resume(f,old,'resume-overlap');await entered.promise;await finish(f,next)
   const released=await until('release overlaps in-flight acceptance',async()=>{const r=await f.row(next);return r?.released?r:undefined});check('pending survives compact during actual overlap',released.nativeRetirements,[{sessionId:old.sessionId,executionId:old.identity.executionId}]);const other=await task(f,'P','overlap-independent');check('other Task native not waiting final release',f.model.waiting.has(other.sessionId),true)
   gate.resolve();faults.delete(old.sessionId);await until('release and pending-clear do not resurrect row',async()=>!await f.row(next));await Promise.allSettled(f.rt.nativeRetirementOperations?.values()??[]);check('no recreated row after concurrent clear',await f.row(next),undefined);await f.sdk.ctx.get('nativeSessionCleaner').drain();check('exact original deleted',await missing(old.file),true)
  }finally{gate.resolve();faults.delete(old.sessionId)}
 }else if(scenario==='idle'){
  f=await fixture();const old=await task(f,'P','idle');f.model.command(old.sessionId,'idle');await until('actual native idle',()=>f.rt.native.get(old.identity.workId)?.observe().state==='idle');await f.sdk.ctx.sessions.flush(f.rt.native.get(old.identity.workId).actualAgent.session);check('idle not stopped',!!f.rt.roleRecords.get(old.identity.workId).stopped,false);check('idle same original Session',f.rt.roleRecords.get(old.identity.workId).sessionId,old.sessionId);check('idle not retired',trace.some(e=>e.event==='retire'&&e.id===old.sessionId),false);check('idle actual file retained',await missing(old.file),false)
 }else if(scenario==='complete-restore-rejected'){
  f=await fixture();const old=await task(f,'P','completed-restore');f.model.command(old.sessionId,'complete')
  const taskPath=path.join(f.dir,'business','tasks',old.identity.taskId+'.json')
  await until('actual Task complete',async()=>JSON.parse(await fs.readFile(taskPath,'utf8')).status==='complete')
  const recorder=await until('Recorder holds the normal completion to Cleaner interval',()=>[...f.rt.roleRecords.values()].find(x=>x.identity.role==='Recorder'&&x.identity.taskId===old.identity.taskId&&f.model.waiting.has(x.sessionId)))
  check('completed Task has its retained original execution',!!await f.row(old),true)
  check('Recorder has not yet saved',f.model.waiting.has(recorder.sessionId),true)
  const metadata=JSON.parse(await fs.readFile(taskPath,'utf8'))
  f.model.nextRestore={taskId:old.identity.taskId,recordPaths:[metadata.sourcePath],route:'P',owner:metadata.owner,continuation:'A later correction needs a new Task ID.'}
  await f.service.send({mode:'local',collaborationId:'po-native',id:'correct-after-complete',createdAt:new Date().toISOString(),text:'Correct the completed Task '+old.identity.taskId+' with a new request.',recipient:'ai',device:'isolated',timezoneOffsetMinutes:0})
  const result=await until('completed Task restore tool result',()=>trace.find(e=>e.event==='tool'&&e.type==='tool/result'&&String(e.data?.message?.toolCallId).startsWith('restore-')))
  check('normal Foreground restore tool rejects completed Task',result.data.message.isError,true)
  const unchanged=JSON.parse(await fs.readFile(taskPath,'utf8'))
  check('completed Task ID remains closed',[unchanged.taskId,unchanged.status,unchanged.lifecycleId],[old.identity.taskId,'complete',metadata.lifecycleId])
  check('no completed Task lifecycle replacement',f.rt.roleRecords.get(old.identity.workId)?.identity.lifecycleId,old.identity.lifecycleId)
  f.model.command(recorder.sessionId,'archive')
  const saved=await until('Recorder save after refused Task restore',()=>trace.find(e=>e.event==='tool'&&e.type==='tool/result'&&String(e.data?.message?.toolCallId).startsWith('archive-')))
  check('independent Recorder save still succeeds',saved.data.message.isError,false)
 }else if(scenario==='header-recovery'||scenario==='release-history'){
  f=await fixture();const old=await task(f,'P','retained');
  if(scenario==='release-history'){
   f.model.command(old.sessionId,{name:'dss_help',input:{facts:'Isolated explicit review of this Task’s terminal release, preserving historical native evidence.'}})
   await until('actual Helper tool registration and model',()=>[...f.rt.roleRecords.values()].find(x=>x.identity.role==='Helper'&&f.model.waiting.has(x.sessionId)))
  }
  await f.service.taskControl({mode:'local',taskId:old.identity.taskId,commandId:'terminal-for-real-restore',intent:'cancelled'})
  await until('actual terminal producer stopped',()=>f.rt.roleRecords.get(old.identity.workId)?.stopped)
  if(scenario==='release-history'){
   const helper=[...f.rt.roleRecords.values()].find(x=>x.identity.role==='Helper'&&f.model.waiting.has(x.sessionId))
   f.model.command(helper.sessionId,{name:'dss_restore',input:{target:old.identity,disposition:'release',facts:'Actual fixture Task is cancelled and producer stopped.',hypotheses:'No business continuation requested by this release.',actionsTaken:'Preserved original source, role memory and native history.',continuation:'Release only internal execution state and preserve original historical Session.'}})
   const released=await until('actual explicit release persisted',async()=>{const r=await f.row(old);return r?.released?r:undefined})
   check('release does not enqueue its own Session',released.nativeRetirements?.some(x=>x.sessionId===old.sessionId)??false,false)
   check('release original historical native remains',await missing(old.file),false)
   check('release current Session not sent Cleaner',trace.some(e=>e.event==='retire'&&e.id===old.sessionId),false)
  }
  const metadata=JSON.parse(await fs.readFile(path.join(f.dir,'business','tasks',old.identity.taskId+'.json'),'utf8'))
  f.model.nextRestore={taskId:old.identity.taskId,recordPaths:[metadata.sourcePath],route:'P',owner:metadata.owner,continuation:'Explicit user-approved fixture restoration of same TaskID from retained original records and original workspace.'}
  mark('recovery-request',{id:old.sessionId})
  await f.service.send({mode:'local',collaborationId:'po-native',id:'restore-after-stop',createdAt:new Date().toISOString(),text:'Restore the exact retained original Task '+old.identity.taskId+' in place, preserving original workspace and historical facts.',recipient:'ai',device:'isolated',timezoneOffsetMinutes:0})
  const next=await until('actual restored native continuation',()=>{const r=f.rt.roleRecords.get(old.identity.workId);return r?.identity.lifecycleId&&!r.stopped&&f.model.waiting.has(r.sessionId)?structuredClone(r):undefined})
  await pendingCleared(f,next);await f.sdk.ctx.get('nativeSessionCleaner').drain()
  const requested=trace.findIndex(e=>e.event==='recovery-request'&&e.id===old.sessionId);const reads=trace.filter((e,i)=>i>requested&&e.id===old.sessionId&&(e.event==='recovery-header-get'||e.event==='native-open'&&e.mode==='read'&&e.caller?.includes('processRestore')))
  check('real recovery read original native header path',reads.length>0,true)
  const retired=trace.findIndex(e=>e.event==='retire'&&e.id===old.sessionId),readIndex=trace.findIndex(e=>reads.includes(e))
  if(scenario==='header-recovery'){check('header read occurs before retirement',retired>readIndex,true);check('actual old removed after reconstruction',await missing(old.file),true)}
  else{check('explicit released history preserved across later replacement',await missing(old.file),false);check('later save still does not enroll preserved old exact ID',retired,-1)}
  mark('restoration-result',{old,next,headerReads:reads})
 }else if(scenario==='released-cold-write'){
  f=await fixture('cold');const old=await task(f,'O','released-cold');await pause(f,old,'cold-release-pause');faults.set(old.sessionId,{error:Error('CONTROLLED journal offline across final release and process exit')});const next=await resume(f,old,'cold-release-resume');await finish(f,next)
  const released=await until('final release persisted before cold exit',async()=>{const r=await f.row(next);return r?.released&&r.nativeRetirements?.some(x=>x.sessionId===old.sessionId)?r:undefined});check('released cold compact owns old pending',released.nativeRetirements,[{sessionId:old.sessionId,executionId:old.identity.executionId}]);await fs.writeFile(path.join(root,'cold.json'),JSON.stringify({old,next},null,2));await f.close();check('released process exit retains exact old log',await missing(old.file),false)
 }else if(scenario==='released-cold-read'){
  const {old,next}=JSON.parse(await fs.readFile(path.join(root,'cold.json'),'utf8'));f=await fixture('cold',true);await until('restart accepts released exact pending',()=>missing(old.file));await until('restart completes existing final retirement',async()=>!await f.row(next));check('released row deleted only after accepted pending',await f.row(next),undefined);check('cold released archive retained',(await fs.readdir(path.join(f.dir,'business','archives'))).length>0,true)
 }else if(scenario==='cold-write'){
  f=await fixture('cold');const old=await task(f,'P','cold');await pause(f,old,'cold-pause');faults.set(old.sessionId,{error:Error('CONTROLLED offline journal before process exit')});const next=await resume(f,old,'cold-resume');await until('failed pending persisted',async()=>!!(await f.row(next))?.nativeRetirements?.length);await fs.writeFile(path.join(root,'cold.json'),JSON.stringify({old,next},null,2));await f.close();check('real process exit retains old exact log',await missing(old.file),false)
 }else if(scenario==='cold-read'){
  const {old,next}=JSON.parse(await fs.readFile(path.join(root,'cold.json'),'utf8'));f=await fixture('cold',true);await until('restart cleans exact old',()=>missing(old.file));const live=await until('restart actual Task continuation',()=>{const r=f.rt.roleRecords.get(next.identity.workId);return r&&f.model.waiting.has(r.sessionId)?r:undefined});await pendingCleared(f,live);check('cold recovery same workId',live.identity.workId,next.identity.workId);check('cold new native different from prior',live.sessionId!==next.sessionId,true)
 }else throw Error('Unknown case '+scenario)
}catch(error){process.exitCode=1;mark('failure',{error:String(error),stack:error.stack});if(f)mark('service-errors',{errors:[...f.service.errors]})}
finally{for(const f of fixtures)try{await f.close()}catch(error){process.exitCode=1;mark('close-failure',{error:String(error)})}await fs.writeFile(path.join(root,'result-'+scenario+'.json'),JSON.stringify({scenario,checks,trace,sdk:evidence()},null,2));await fs.writeFile(path.join(root,'executed-'+scenario+'.mjs'),script)}

export {fixture,Model,trace,checks,mark,check,until,hash,tool,results,lastResults,faults,physicalHolds,defer,missing,root,evidence}
