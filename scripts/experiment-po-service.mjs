// Isolated experiment. Complete production Service/Host and actual pinned SDK.
// Only model wire source is controlled, with no network. No role row/state seeding.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {rmSync} from 'node:fs'
import path from 'node:path'
import {AsyncLocalStorage} from 'node:async_hooks'
import {createHash} from 'node:crypto'
import {evidence} from './test-support/dsh-sdk-runtime.mjs'
import {openDshStorageFixture} from './test-support/dsh-sdk-storage.mjs'
const {AgentRegistry}=await import('@deepseek-ai/dsh-agent')
const {SessionStore}=await import('@deepseek-ai/dsh-session')
const {SessionProjectionRegistry}=await import('@deepseek-ai/dsh-session-projection')
const {LlmRuntime,LlmAdapter}=await import('@deepseek-ai/dsh-llm')
const {ToolRuntime}=await import('@deepseek-ai/dsh-tools')
const {SystemPrompt}=await import('@deepseek-ai/dsh-system-prompt')
const {AgentLoop}=await import('@deepseek-ai/dsh-agent-loop')
const {LocalJobRegistry}=await import('@deepseek-ai/dsh-jobs-local')
const {WorkspaceRegistry}=await import('@deepseek-ai/dsh-workspace')
const {LocalFileSystem}=await import('@deepseek-ai/dsh-fs-local')
const {WorkingDirectoryService}=await import('@deepseek-ai/dsh-working-directory')
const jsonl=await import('@deepseek-ai/dsh-session-persistence-jsonl')
const cleaner=await import('../src/native-cleaner/plugin.mjs')
const {NativeCleanerCoordinator}=await import('../src/native-cleaner/coordinator.mjs')
const {RetirementStore}=await import('../src/native-cleaner/retirement-store.mjs')
const {ExactJsonlAdapter,sessionDirectory}=await import('../src/native-cleaner/jsonl-adapter.mjs')
const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {ExecutionControls}=await import('../src/framework/execution-control.ts')
const {FrameworkService}=await import('../src/framework/service.ts')
const scriptSource=await fs.readFile(new URL(import.meta.url),'utf8')
const root=process.env.DSS_PO_EVIDENCE_ROOT??await fs.mkdtemp('/tmp/dss-po-service-')
if(!process.env.DSS_PO_EVIDENCE_ROOT)process.once('exit',()=>rmSync(root,{recursive:true,force:true}))
await fs.mkdir(root,{recursive:true})
const trace=[],checks=[],scenarios=[]; const expectResume=true; const expectEarly=process.env.DSS_PO_EXPECT_RETIREMENT!=='0'; const hash=x=>createHash('sha256').update(x).digest('hex')
const mark=(event,data={})=>{trace.push({event,...data});console.log(event,JSON.stringify(data))}
const check=(name,a,b)=>{assert.deepEqual(a,b,name);checks.push(name)}
const retire=NativeCleanerCoordinator.prototype.retire
NativeCleanerCoordinator.prototype.retire=function(id){mark('cleaner-retire-request',{sessionId:id});return retire.call(this,id)}
const originalAccept=RetirementStore.prototype.accept, originalCleanup=ExactJsonlAdapter.prototype.cleanup
RetirementStore.prototype.accept=async function(lives,verify){mark('cleaner-journal-attempt',{ids:lives.map(x=>x.id)});const r=await originalAccept.call(this,lives,verify);mark('cleaner-journal-accepted',{ids:lives.map(x=>x.id)});return r}
ExactJsonlAdapter.prototype.cleanup=async function(life){mark('cleaner-physical',{sessionId:life.id});return originalCleanup.call(this,life)}
const ioScope=new AsyncLocalStorage();let nextControlReadId=1
const fileIds=new WeakMap();let nextFileId=1
const fileId=f=>{if(!fileIds.has(f))fileIds.set(f,nextFileId++);return fileIds.get(f)}
const snapshots=PhysicalLocalFiles.prototype.snapshot,readBytes=PhysicalLocalFiles.prototype.readBytes,taskStates=ExecutionControls.prototype.taskStates
PhysicalLocalFiles.prototype.snapshot=async function(...args){const r=await snapshots.apply(this,args);mark('io-view',{store:fileId(this),revision:r.revision,controlReadId:ioScope.getStore()});return r}
PhysicalLocalFiles.prototype.readBytes=function(snapshot,p,...rest){mark('io-read',{store:fileId(this),revision:snapshot?.revision,path:p,ownView:this.views.has(snapshot),controlReadId:ioScope.getStore()});return readBytes.call(this,snapshot,p,...rest)}
ExecutionControls.prototype.taskStates=function(targets,snapshot){const id=nextControlReadId++;mark('controls-read',{controlReadId:id,caller:new Error().stack,store:fileId(this.files),targets:targets.map(x=>typeof x==='string'?x:{taskId:x.taskId,lifecycleId:x.lifecycleId}),borrowed:!!snapshot,ownView:snapshot?this.files.views.has(snapshot):undefined});return ioScope.run(id,()=>taskStates.call(this,targets,snapshot))}
// This wall-clock guard bounds this experiment, not any product timer or gate.
async function until(label,read,limit=15000){const end=Date.now()+limit;let value;while(!(value=await read())){if(Date.now()>end)throw Error('Experiment wait expired: '+label);await new Promise(r=>setTimeout(r,10))}return value}
class ControlledModel extends LlmAdapter {
 calls=[]; nextRestore; completedForeground=new Set(); claimedSessions=new Set()
 async *stream(options){const n=this.calls.length+1;this.calls.push(options);mark('model-stream-start',{n,sessionId:options.sessionId,keys:Object.keys(options),signal:!!options.signal});if(this.nextRestore && options.tools.some(t=>t.name==='dss_task_restore')){
   const input=this.nextRestore;this.nextRestore=undefined;this.completedForeground.add(options.sessionId)
   mark('model-real-tool-request',{sessionId:options.sessionId,name:'dss_task_restore',input})
   yield {type:'tool-call-delta',index:0,id:'restore-'+input.route,name:'dss_task_restore',argumentsDelta:JSON.stringify(input)}
   yield {type:'finish',reason:'tool-calls'};return
 }
 if(process.env.DSS_PO_CLAIM==='1'&&!this.claimedSessions.has(options.sessionId)&&options.tools.some(t=>['dss_worker_assign','dss_planner_dispatch'].includes(t.name))){
   this.claimedSessions.add(options.sessionId);mark('model-real-claim',{sessionId:options.sessionId})
   yield {type:'tool-call-delta',index:0,id:'claim-'+n,name:'dss_claim',argumentsDelta:'{}'}
   yield {type:'finish',reason:'tool-calls'};return
 }
 if(this.completedForeground.has(options.sessionId)){yield {type:'text-delta',index:0,text:'Restoration request handed to the existing Host.'};yield {type:'finish',reason:'stop'};return}
 yield {type:'text-delta',index:0,text:'Isolated model output '+n}; await new Promise((resolve,reject)=>{if(options.signal.aborted)return reject(options.signal.reason);options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true})});}
}
let sdk,service,plugin,model
try{
 const dir=path.join(root,'fixture');await fs.mkdir(path.join(dir,'workspace'),{recursive:true})
 sdk=await openDshStorageFixture(path.join(dir,'storage'),path.join(dir,'locator'))
 new AgentRegistry(sdk.ctx);new SessionStore(sdk.ctx);new SessionProjectionRegistry(sdk.ctx);new LlmRuntime(sdk.ctx);new SystemPrompt(sdk.ctx,{});new ToolRuntime(sdk.ctx);new LocalJobRegistry(sdk.ctx,{})
 plugin=sdk.ctx.plugin(jsonl,{root:path.join(dir,'sessions'),compression:'none'});await plugin.await()
 new LocalFileSystem(sdk.ctx,{cwd:path.join(dir,'workspace'),diffBasisMaxBytes:1048576})
 new WorkingDirectoryService(sdk.ctx,{defaultDirectory:path.join(dir,'workspace')})
 const wp=sdk.ctx.plugin(WorkspaceRegistry);await wp.await()
 sdk.ctx.on('session/event',(session,event)=>{if(['tool/call','tool/result'].includes(event.type))mark('actual-sdk-tool-event',{sessionId:session.header.id,type:event.type,data:event.data})})
 const loopPlugin=sdk.ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:10});await loopPlugin.await()
 model=new ControlledModel();sdk.ctx.llm.registerAdapter(['isolated-wire'],model)
 await cleaner.apply(sdk.ctx,{}, {onFailure(error,stage){throw new Error(stage,{cause:error})}})
 service=new FrameworkService(sdk.ctx,sdk.adapter,{name:'PO isolated',userName:'Evidence',localDirectory:path.join(dir,'business'),ownerRepo:'',repositoryDirectory:path.join(dir,'git-not-used'),collaborationId:'po-isolated',workerSeats:1,workspace:path.join(dir,'workspace'),foreground:{provider:'isolated-wire',model:'controlled'},background:{provider:'isolated-wire',model:'controlled'}})
 await service.start();mark('service-start',{view:await service.view({headerOnly:true})})
 let active=service.running.get('local');assert(active,'Complete Service must connect actual Host');let rt=active.runtime
 await fs.mkdir(path.join(dir,'business','tasks'),{recursive:true})
 for(const route of ['P','O']){
   const sourcePath='tasks/Experiment_'+route+'.md';await fs.writeFile(path.join(dir,'business',sourcePath),'# Isolated original '+route+' task\nExercise pause and continue; do not complete this Task.\n')
   mark('source-file-published',{route,sourcePath})
   const role=route==='P'?'Planner':'Organizer'
   const row=await until(role+' actual admission',()=>[...rt.roleRecords.values()].find(x=>x.identity.role===role&&!x.stopped&&rt.native.get(x.identity.workId)))
   await until(role+' actual model stream',()=>model.calls.filter(x=>x.sessionId===row.sessionId).length>=(process.env.DSS_PO_CLAIM==='1'?2:1))
   for(let cycle=1;cycle<=2;cycle++){
   const original=structuredClone(rt.roleRecords.get(row.identity.workId)),owned=rt.native.get(row.identity.workId)
   check(role+' native Session exact',owned.actualAgent.session.header.id,original.sessionId)
   await sdk.ctx.sessions.flush(owned.actualAgent.session)
   const nativeFile=path.join(sessionDirectory(path.join(dir,'sessions'),owned.actualAgent.session.header),'session.v'+owned.actualAgent.session.header.version+'.jsonl')
   const before=await fs.readFile(nativeFile)
   check(role+' original log nonempty before pause',before.length>0,true)
   check(role+' real accepted user/message in log',before.toString().includes('user/message'),true)
   await fs.writeFile(path.join(root,route+'-'+cycle+'-before.jsonl'),before)
   mark('admitted-materialized',{role,record:original,nativeFile,bytes:before.length,sha256:hash(before)})
   const baselineRequests=trace.filter(x=>x.event==='cleaner-retire-request'&&x.sessionId===original.sessionId).length
   check(role+' no cleanup while active',baselineRequests,0)
   const submission={mode:'local',storageScope:active.connection.scope,taskId:original.identity.taskId,...original.identity.lifecycleId?{lifecycleId:original.identity.lifecycleId}:{}}
   mark('service-pause-request',{role,...submission})
   const paused=await service.taskControl({...submission,commandId:'pause-'+route+'-'+cycle,intent:'paused'})
   mark('service-pause-return',{role,paused})
   const stopped=await until(role+' actual native stop',()=>{const r=rt.roleRecords.get(original.identity.workId);return r?.stopped&&r.stopIntent?.phase==='disposed'?structuredClone(r):undefined})
   check(role+' native ownership ended',rt.native.get(original.identity.workId),undefined)
   check(role+' exact execution stopped',stopped.identity.executionId,original.identity.executionId)
   check(role+' exact Session stopped',stopped.sessionId,original.sessionId)
   check(role+' no stop unknown',stopped.stopUnknown,undefined)
   check(role+' no pending native jobs',stopped.stopIntent.jobs,[])
   check(role+' model cancellation actual',model.calls.find(x=>x.sessionId===original.sessionId).signal.aborted,true)
   const closed=await fs.readFile(nativeFile)
   await fs.writeFile(path.join(root,route+'-'+cycle+'-closed.jsonl'),closed)
   mark('confirmed-stopped',{role,record:stopped,bytes:closed.length,sha256:hash(closed),nativeStillExists:true})
   mark('service-resume-request',{role,...submission})
   let resumed,resumeError
   try{resumed=await service.taskControl({...submission,commandId:'resume-'+route+'-'+cycle,intent:'running'});mark('service-resume-return',{role,cycle,resumed})}
   catch(error){resumeError={message:String(error),stack:error.stack};mark('service-resume-error',{role,cycle,...resumeError})}
   const controlPath=path.join(dir,'business','task-runs',original.identity.taskId,'control.json')
   const controls=JSON.parse(await fs.readFile(controlPath,'utf8'))
   const stateDir=path.join(dir,'business','state',active.connection.registration.member,original.identity.taskId)
   const immediate={role,cycle,controls,signals:await fs.readdir(stateDir),roleRow:structuredClone(rt.roleRecords.get(original.identity.workId)),resumeError}
   await fs.writeFile(path.join(root,route+'-'+cycle+'-immediate-after-resume.json'),JSON.stringify(immediate,null,2))
   mark('resume-immediate-state',immediate)
   check(role+' cycle '+cycle+' command state committed even if response fails',Object.values(controls.tasks)[0].intent,'running')
   if(!expectResume){
     check(role+' baseline cross-store error',resumeError?.message,'Error: Physical read view was released or belongs to another store.')
     // Wait only for ordinary existing Host observation; never invoke recovery or mutate a row.
     let natural
     try{natural=await until(role+' natural Host after failed running response',()=>{const r=rt.roleRecords.get(original.identity.workId);return r?.sessionId!==original.sessionId?r:undefined},2500)}catch(error){mark('baseline-no-natural-replacement-in-observed-window',{role,cycle,message:String(error)})}
     mark('baseline-after-observation',{role,cycle,row:structuredClone(rt.roleRecords.get(original.identity.workId)),nativePresent:!!rt.native.get(original.identity.workId),oldFileBytes:(await fs.readFile(nativeFile)).length})
     scenarios.push({role,cycle,original,stopped,controls,resumeError,natural:!!natural})
     if(!natural)break
   }else check(role+' candidate resume does not reject',resumeError,undefined)
   const next=await until(role+' actual new execution',()=>{const r=rt.roleRecords.get(original.identity.workId);return r&&!r.stopped&&r.sessionId!==original.sessionId&&rt.native.get(r.identity.workId)?structuredClone(r):undefined})
   await until(role+' new model stream',()=>model.calls.filter(x=>x.sessionId===next.sessionId).length>=(process.env.DSS_PO_CLAIM==='1'?2:1))
   await sdk.ctx.sessions.flush(rt.native.get(next.identity.workId).actualAgent.session)
   await sdk.ctx.get('nativeSessionCleaner').drain()
   check(role+' same workId resumed',next.identity.workId,original.identity.workId)
   check(role+' new execution identity',next.identity.executionId!==original.identity.executionId,true)
   check(role+' new native Session identity',next.sessionId!==original.sessionId,true)
   check(role+' old exact Session handoff',trace.some(x=>x.event==='cleaner-retire-request'&&x.sessionId===original.sessionId),expectEarly)
   const retained=await fs.readFile(nativeFile).catch(e=>e.code==='ENOENT'?undefined:Promise.reject(e));check(role+' old exact file state',retained,expectEarly?undefined:closed)
   const task=JSON.parse(await fs.readFile(path.join(dir,'business','tasks',original.identity.taskId+'.json'),'utf8'))
   check(role+' original Task remains running',task.status,'running')
   const newAgent=rt.native.get(next.identity.workId).actualAgent
   const newFile=path.join(sessionDirectory(path.join(dir,'sessions'),newAgent.session.header),'session.v'+newAgent.session.header.version+'.jsonl')
   const newBytes=await fs.readFile(newFile)
   check(role+' actual new log is nonempty',newBytes.length>0,true)
   await fs.writeFile(path.join(root,route+'-'+cycle+'-new.jsonl'),newBytes)
   const prefix='framework-runtime/'+hash(active.connection.scope)+'/'
   const durable=await active.connection.records.get(prefix+'roles/'+hash(original.identity.workId))
   check(role+' current durable role overwritten with new Session',durable.sessionId,next.sessionId)
   check(role+' no pending old Session in current durable role',durable.nativeRetirements??[],[])
   mark('resumed-materialized',{role,record:next,durable,nativeFile:newFile,bytes:newBytes.length,sha256:hash(newBytes),oldBytes:closed.length,oldSha256:hash(closed)})
   scenarios.push({role,cycle,sourcePath,workId:original.identity.workId,original,stopped,next,durable,nativeFile,newFile,closedSha256:hash(closed),oldRetireRequests:trace.filter(x=>x.event==='cleaner-retire-request'&&x.sessionId===original.sessionId).length})
   }
 }
 if(process.env.DSS_PO_EXTENDED==='1'){
   const selected=[...rt.roleRecords.values()].filter(r=>['Planner','Organizer'].includes(r.identity.role)).map(r=>structuredClone(r))
   mark('withdraw-request');await service.participation({mode:'local',enabled:false});check('withdraw actual Running removed',service.running.has('local'),false)
   const callsBefore=model.calls.length
   for(const record of selected){
     const taskId=record.identity.taskId,role=record.identity.role,base={mode:'local',storageScope:active.connection.scope,taskId}
     const file=path.join(dir,'business','task-runs',taskId,'control.json')
     for(const intent of ['paused','running']){
       const result=await service.taskControl({...base,commandId:'inactive-'+role+'-'+intent,intent,lifecycleId:''})
       check('inactive '+role+' '+intent+' returns',result.submitted,true)
     }
     const before=await fs.readFile(file)
     await assert.rejects(()=>service.taskControl({...base,commandId:'wrong-lifecycle-'+role,intent:'paused',lifecycleId:'not-current'}),/earlier lifecycle/)
     checks.push('inactive '+role+' noncurrent lifecycle rejected')
     check('inactive '+role+' wrong lifecycle leaves controls unchanged',await fs.readFile(file),before)
     const controls=JSON.parse(before)
     check('inactive '+role+' resume completion on original command',Object.values(controls.commands).find(x=>x.value.commandId==='inactive-'+role+'-running').resumeHandled,true)
     mark('inactive-controls',{role,controls})
   }
   check('inactive buttons do not create Agents',model.calls.length,callsBefore)
   await service.participation({mode:'local',enabled:true});active=service.running.get('local');rt=active.runtime
   for(const record of selected)await until('reactivate actual '+record.identity.role,()=>{const r=rt.roleRecords.get(record.identity.workId);return r&&!r.stopped&&rt.native.get(r.identity.workId)&&model.calls.some(c=>c.sessionId===r.sessionId)})
   mark('reactivated',{rows:[...rt.roleRecords.values()]})
   if(process.env.DSS_PO_LIFECYCLE==='1')for(const selectedRecord of selected.filter(r=>!process.env.DSS_PO_LIFECYCLE_ROUTE||r.identity.role===(process.env.DSS_PO_LIFECYCLE_ROUTE==='P'?'Planner':'Organizer'))){
     const taskId=selectedRecord.identity.taskId,role=selectedRecord.identity.role,route=role==='Planner'?'P':'O',taskPath=path.join(dir,'business','tasks',taskId+'.json')
     const originalTask=JSON.parse(await fs.readFile(taskPath,'utf8'))
     await service.taskControl({mode:'local',storageScope:active.connection.scope,taskId,commandId:'terminal-before-restore-'+route,intent:'cancelled'})
     check(role+' actual terminal Task for lifecycle restoration',JSON.parse(await fs.readFile(taskPath,'utf8')).status,'cancelled')
     model.nextRestore={taskId,recordPaths:[originalTask.sourcePath],route,owner:originalTask.owner,continuation:'Isolated user-approved in-place restoration of retained original Task to verify lifecycle control. Keep original workspace and files.'}
     await service.send({mode:'local',collaborationId:'po-isolated',storageScope:active.connection.scope,id:'restore-request-'+route,createdAt:new Date().toISOString(),text:'Restore the original '+route+' Task '+taskId+' in place from its retained original records. This is an explicit isolated fixture request.',recipient:'ai',device:'isolated-test',timezoneOffsetMinutes:0})
     const restored=await until(role+' actual restored lifecycle',async()=>{const t=JSON.parse(await fs.readFile(taskPath,'utf8'));return t.lifecycleId&&t.status==='running'?t:undefined})
     mark('actual-restored-lifecycle',{role,restored})
     const live=await until(role+' restored actual native',()=>{const r=rt.roleRecords.get(selectedRecord.identity.workId);return r?.identity.lifecycleId===restored.lifecycleId&&!r.stopped&&rt.native.get(r.identity.workId)&&model.calls.some(c=>c.sessionId===r.sessionId)?structuredClone(r):undefined})
     const controlFile=path.join(dir,'business','task-runs',taskId,'control.json'),before=await fs.readFile(controlFile).catch(e=>e.code==='ENOENT'?undefined:Promise.reject(e))
     await assert.rejects(()=>service.taskControl({mode:'local',taskId,commandId:'omit-restored-'+route,intent:'paused'}),/earlier lifecycle/);checks.push(role+' omitted restored lifecycle rejected')
     check(role+' rejected stale lifecycle leaves bytes unchanged',await fs.readFile(controlFile).catch(e=>e.code==='ENOENT'?undefined:Promise.reject(e)),before)
     const correct={mode:'local',taskId,lifecycleId:restored.lifecycleId}
     await service.taskControl({...correct,commandId:'restored-pause-'+route,intent:'paused'})
     await until(role+' restored actual stop',()=>{const r=rt.roleRecords.get(live.identity.workId);return r?.stopped&&r.stopIntent?.phase==='disposed'})
     let error
     try{await service.taskControl({...correct,commandId:'restored-resume-'+route,intent:'running'})}catch(e){error=String(e);mark('restored-resume-error',{role,error})}
     check(role+' restored button response',error,expectResume?undefined:'Error: Physical read view was released or belongs to another store.')
     let replacement
     try{replacement=await until(role+' restored new execution',()=>{const r=rt.roleRecords.get(live.identity.workId);return r?.sessionId!==live.sessionId&&!r.stopped&&rt.native.get(r.identity.workId)?structuredClone(r):undefined},expectResume?15000:3000)}
     catch(e){if(expectResume)throw e;mark('baseline-restored-no-new-execution-in-observed-window',{role,error:String(e)})}
     if(replacement)check(role+' resumed exact restored lifecycle',replacement.identity.lifecycleId,restored.lifecycleId)
     mark('lifecycle-button-result',{role,old:live,replacement,current:structuredClone(rt.roleRecords.get(live.identity.workId)),control:JSON.parse(await fs.readFile(controlFile,'utf8'))})

   }
 }

}catch(error){process.exitCode=1;mark('failure',{message:String(error),stack:error.stack});if(service)mark('service-errors',{errors:[...service.errors],reported:[...service.reportedErrors].map(([k,v])=>[k,[...v]])})}
finally{
 try{await service?.dispose();mark('service-disposed')}catch(error){mark('dispose-error',{error:String(error)});process.exitCode=1}
 try{await sdk?.ctx.get('nativeSessionCleaner')?.drain();await plugin?.dispose();await sdk?.close()}catch(error){mark('fixture-close-error',{error:String(error)});process.exitCode=1}
 await fs.writeFile(path.join(root,'executed-script.mjs'),scriptSource)
 await fs.writeFile(path.join(root,'result.json'),JSON.stringify({checks,scenarios,trace,sdk:evidence()},null,2)+'\n')
}
