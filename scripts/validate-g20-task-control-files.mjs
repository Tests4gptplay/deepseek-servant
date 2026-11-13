import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {registerHooks,stripTypeScriptTypes} from 'node:module'
import {sourceRoot,hash,hooks,evidence,loaded} from './test-support/dsh-sdk-runtime.mjs'
import {openDshStorageFixture} from './test-support/dsh-sdk-storage.mjs'
const supplemental=registerHooks({resolve(s,c,next){if(s==='mdast-util-from-markdown')return{url:'data:text/javascript,export function fromMarkdown(){throw new Error("Markdown parsing is outside this control test")}',shortCircuit:true};return next(s,c)}})
// Real SDK persistence, Local files, controls, resume/cancel publishers, Host
// polling, and extracted unchanged-in-body Runtime/Service entry methods.
// No model runs: native stopping and task-resume scheduling are explicit ports.
const {PhysicalLocalFiles,LocalTaskRecordParentMissing}=await import('../src/framework/physical-local-files.ts')
const {ExecutionControls}=await import('../src/framework/execution-control.ts')
const {FrameworkHostLoop}=await import('../src/framework/host-loop.ts')
const {FrameworkCleaner,readTaskCleanupRecord}=await import('../src/framework/cleaner.ts')
const {GitAuthorityStore}=await import('../src/framework/git-authority.ts')
const {withSnapshot,withOperationChannel}=await import('../src/framework/transactions.ts')
const {paths,readJson,taskLifecycle,taskLifecycleKey,preparePhysicalTask,isTerminalTask,encodeJson}=await import('../src/framework/task-files.ts')
const {taskFamily}=await import('../src/framework/task-relations.ts')
const {publishTaskResume}=await import('../src/framework/task-resume.ts')
const {submitTaskCancellation}=await import('../src/framework/task-cancellation.ts')
const {physicalControlSignalSources}=await import('../src/framework/physical-control-signal-sources.ts')
const {z}=await import('zod')
function extract(file,names,deps) {
 const src=readFileSync(new URL('framework/'+file+'.ts',sourceRoot),'utf8');loaded.set('framework/'+file+'.ts',hash(src));const js=stripTypeScriptTypes(src,{mode:'transform'})
 const method=name=>{const m=new RegExp('\\n    (?:async )?'+name+'(?:<[^\\n]+>)?\\(').exec(js);assert(m,name);const start=m.index+1,next=/\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(js.slice(start+m[0].length));return next?js.slice(start,start+m[0].length+next.index):js.slice(start,js.lastIndexOf('\n}'))}
 return new Function(...Object.keys(deps),'return class {\n'+names.map(method).join('\n')+'\n}')(...Object.values(deps))
}
const Runtime=extract('role-runtime',['roleKey','rememberTerminalTask','requestExecutionStop','retryStartupControls','startTaskControlDiscovery','applyUserControls','serialWork','startMaintenance','dispose','disposeOwned','cancelledByShutdown','settleOperations'],{PhysicalLocalFiles,LocalTaskRecordParentMissing,GitAuthorityStore,taskLifecycle,taskLifecycleKey,taskFamily,isTerminalTask,withSnapshot,withOperationChannel,annotateFailure:e=>e})
const Service=extract('service',['controls','taskControl','stopExecution','checkScope'],{ExecutionControls,PhysicalLocalFiles,withSnapshot,withOperationChannel,readTaskCleanupRecord,readJson,paths,taskLifecycle,publishTaskResume,submitTaskCancellation,physicalControlSignalSources,z})
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'dss-g20-control-')),checks=[],errors=[],cost={get:[],set:[],list:[]},events=[]
const ok=(name,value,expected)=>{assert.deepEqual(value,expected,name);checks.push({name,value})}
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
const tick=()=>new Promise(setImmediate),until=async predicate=>{const deadline=performance.now()+5000;for(;;){if(await predicate())return;if(performance.now()>=deadline)throw Error('Controlled boundary timed out');await new Promise(resolve=>setTimeout(resolve,1))}}
const sdk=await openDshStorageFixture(path.join(temp,'sdk'),path.join(temp,'locator')),storage=sdk.adapter
for(const name of ['get','set','list']){const original=storage[name].bind(storage);storage[name]=async(...args)=>{cost[name].push(args[0]);return original(...args)}}
const files=new PhysicalLocalFiles(path.join(temp,'physical')),scope='g20-test',controls=new ExecutionControls(storage,scope,()=> 'test-time',files,storage,'test-host')
let sequence=0
async function task(route='P') {const taskId='90000000-0000-4000-8000-'+String(++sequence).padStart(12,'0'),source='tasks/task'+sequence+'_'+route+'.md';await files.replace(source,'Actual test Task '+sequence);return withSnapshot(files,s=>preparePhysicalTask(files,s,source,{taskId,owner:'A',members:['A']}))}
const rt=Object.assign(new Runtime(),{files,controls,config:{scope,member:'A',mode:'local'},environment:{changed(){}},pendingControlStops:[],pendingTaskControlDiscovery:new Map(),startupControlsDiscovered:true,knownTaskLifecycles:new Map(),observedTerminalTasks:new Map(),roleRecords:new Map(),workOperations:new Map(),stopOperations:new Map(),currentTask:async r=>r.identity.taskId,error(e){errors.push(String(e)+ (e.errors ? ": "+e.errors.map(String).join("; ") : ""))},trackedStop(r){events.push(['native-stop-port',r.identity.executionId]);r.stopped=true;return true},scheduleTaskResume(...args){events.push(['resume-schedule-port',...args])}})
const access={connection:{files,sharedRecords:storage,records:storage,scope,identity:{instanceUUID:'test-host'},registration:{member:'A'},transactions:{run(){throw Error('No Local SQL publication')}}}}
const service=Object.assign(new Service(),{running:new Map([['local',{connection:access.connection,runtime:rt}]]),access:async()=>access,withAccessOperation:async(input,action)=>{service.checkScope(access,input.storageScope);return action(access)},beforeLocalTaskUse:async()=>true})
rt.loop=new FrameworkHostLoop(files,{},storage,{member:'A',primary:true,scope,instanceUUID:'test-host'},()=>['A'],{})
const control=(t,intent,commandId)=>service.taskControl({mode:'local',storageScope:scope,taskId:t.taskId,lifecycleId:t.lifecycleId,intent,commandId})
const stop=(r,commandId)=>service.stopExecution({mode:'local',storageScope:scope,commandId,workId:r.identity.workId,executionId:r.identity.executionId})
const role=(t,e,extra={})=>({identity:{role:'Planner',taskId:t.taskId,lifecycleId:t.lifecycleId,workId:'planner:'+t.taskId,executionId:e},stopped:true,...extra})
async function drain(){const deadline=performance.now()+5000;for(;;){const ops=[...rt.maintenance?.values()??[]];if(!ops.length)return;if(performance.now()>=deadline)throw Error('Maintenance did not drain');await Promise.allSettled(ops);await new Promise(resolve=>setTimeout(resolve,1))}}
try {
 const a=await task(),b=await task(),oa=controls.taskRecordPath(a.taskId)
 ok('Task path names actual Task root',oa,paths.run(a.taskId)+'/control.json')
 const pause=await control(a,'paused','a-pause');ok('real Service pause accepted',pause.submitted,true)
 ok('pause stored in physical file',(await withSnapshot(files,s=>readJson(files,s,oa))).tasks[hash(taskLifecycleKey(a))].intent,'paused')
 ok('Task control does not write SDK controls',cost.set.filter(x=>x.startsWith('framework-user-controls/')),[])
 ok('Task control does not read legacy SDK controls',cost.get.filter(x=>x.startsWith('framework-user-controls/')),[])
 const resume=await control(a,'running','a-resume');ok('real Service resume accepted',resume.submitted,true)
 ok('resume completion retained on same original file',(await withSnapshot(files,s=>readJson(files,s,oa))).commands[hash('a-resume')].resumeHandled,true)
 ok('resume temporary publication removed',await files.entryInfo(paths.run(a.taskId)+'/.user-resume-'+hash('a-resume')+'.json'),undefined)
 await control(a,'paused','a-pause');ok('old successful replay does not overwrite newer running',(await controls.task(a.taskId)).intent,'running')
 await assert.rejects(control(a,'running','a-pause'),/different arguments/);ok('same Task command signature checked',true,true)
 await control(b,'paused','a-pause');ok('independent Task owns its own command namespace',(await controls.task(b.taskId)).intent,'paused')
 const parent=await task('O'),child=await task('O'),grand=await task();parent.children=[{taskId:child.taskId,objectiveId:'child',member:'A'}];child.parent={taskId:parent.taskId,owner:'A',objectiveId:'child'};child.children=[{taskId:grand.taskId,objectiveId:'grand',member:'A'}];grand.parent={taskId:child.taskId,owner:'A',objectiveId:'grand'};for(const t of [parent,child,grand])await files.replace(paths.task(t.taskId),encodeJson(t))
 await control(parent,'paused','parent-pause');ok('real parent relation confers pause to descendant',await controls.taskHeld(grand.taskId),true)
 await control(parent,'running','parent-resume');ok('parent resume clears inherited pause',await controls.taskHeld(grand.taskId),false)
 const p=await task(),r=role(p,'execution-1');rt.roleRecords.set(r.identity.workId,r)
 await stop(r,'stop-1');await drain();ok('real Service Runtime stop settles original physical owner',(await controls.execution(r.identity)).result.state,'stopped')
 const r2=role(p,'execution-2');rt.roleRecords.set(r.identity.workId,r2);await stop(r2,'stop-2');await drain();const r3=role(p,'execution-3');rt.roleRecords.set(r.identity.workId,r3);await stop(r3,'stop-3');await drain()
 const body=await withSnapshot(files,s=>readJson(files,s,controls.taskRecordPath(p.taskId)));ok('all three accepted generation bodies share one Task file',Object.keys(body.executions).length,3)
 // These are supplied confirmed-stopped identities; no claim of three native admissions.
 const cleaner=new FrameworkCleaner(files,{run(){throw Error('Physical Cleaner cannot use SQL')}})
 const terminal={...p,status:'complete'};await files.replace(paths.task(p.taskId),encodeJson(terminal));await cleaner.clean(terminal,{snapshot:{},task:terminal,family:[terminal],startedAt:0,status:'delete'})
 ok('real Cleaner removes every generation without execution ID enumeration',await files.entryInfo(paths.run(p.taskId)),undefined)
 const beforeWrites=cost.set.length;await controls.releaseTask(p.taskId,undefined,['execution-3']);ok('physical control release no longer rewrites SDK legacy state',cost.set.length,beforeWrites)
 r3.released=true;await stop(r3,'late-new');ok('late released stop cannot recreate Task root',await files.entryInfo(paths.run(p.taskId)),undefined)
 const unknown=await task(),ur=role(unknown,'unknown-execution');rt.roleRecords.set(ur.identity.workId,ur)
 const originalUpdate=files.updateInExistingDirectory.bind(files);let failAfter=true
 files.updateInExistingDirectory=async(p,build,signal)=>{const result=await originalUpdate(p,build,signal);if(p===controls.taskRecordPath(unknown.taskId)&&failAfter){failAfter=false;throw Error('UNKNOWN after actual rename')}return result}
 await assert.rejects(stop(ur,'unknown-command'),/UNKNOWN after actual rename/);await drain();ok('UNKNOWN keeps fully atomic original command',(await withSnapshot(files,s=>readJson(files,s,controls.taskRecordPath(unknown.taskId)))).commands[hash('unknown-command')].value.commandId,'unknown-command')
 await stop(ur,'unknown-command');await drain();ok('retry confirms existing original request without duplicate native stop',(await controls.execution(ur.identity)).result.state,'stopped');files.updateInExistingDirectory=originalUpdate
 // Original released retry owns the same accepted promise until its actual
 // UNKNOWN resolves; an unrelated newly addressed command cannot erase it.
 const retryTask=await task(),retryRole=role(retryTask,'retry-original'),renameEntered=defer(),renameRelease=defer();rt.roleRecords.set(retryRole.identity.workId,retryRole)
 let rejectAfterRename=true
 files.updateInExistingDirectory=async(p,build,signal)=>{const result=await originalUpdate(p,build,signal);if(p===controls.taskRecordPath(retryTask.taskId)&&rejectAfterRename){rejectAfterRename=false;renameEntered.resolve();await renameRelease.promise;throw Error('Original atomic write UNKNOWN')}return result}
 const originalAttempt=stop(retryRole,'original-unknown').then(value=>({value}),error=>({error:String(error)}));await renameEntered.promise;retryRole.released=true
 let retryDone=false;const originalRetry=stop(retryRole,'original-unknown').then(value=>({value}),error=>({error:String(error)})).finally(()=>retryDone=true)
 await tick();ok('released same-command retry retains original pending promise',retryDone,false)
 await control(b,'running','peer-during-original-unknown');ok('original UNKNOWN does not block unrelated Task',true,true)
 renameRelease.resolve();const [attemptResult,retryResult]=await Promise.all([originalAttempt,originalRetry]);ok('original caller retains actual UNKNOWN',attemptResult.error,'Error: Original atomic write UNKNOWN');ok('immediate same-command retry returns that original UNKNOWN',retryResult.error,attemptResult.error);await drain();files.updateInExistingDirectory=originalUpdate
 await stop(retryRole,'original-unknown');ok('later retry resolves from complete atomic original command',(await controls.execution(retryRole.identity)).commandId,'original-unknown')
 const newerRole=role(retryTask,'retry-successor',{released:true});rt.roleRecords.set(newerRole.identity.workId,newerRole)
 await assert.rejects(stop(newerRole,'original-unknown'),/different arguments/);ok('released shortcut never bypasses same-Task command signature',true,true)
 const coldControls=new ExecutionControls(storage,scope,undefined,files,storage,'test-host')
 await assert.rejects(coldControls.acknowledgeLocalReleasedExecutionStop('original-unknown',newerRole.identity),/different arguments/);ok('cold exact-file acknowledgement checks original signature',true,true)
 const held=await task(),hr=role(held,'held-write'),entered=defer(),release=defer();rt.roleRecords.set(hr.identity.workId,hr)
 files.updateInExistingDirectory=(p,build,signal)=>originalUpdate(p,async bytes=>{if(p===controls.taskRecordPath(held.taskId)){entered.resolve();await release.promise}return build(bytes)},signal)
 const pending=stop(hr,'held-command').then(()=>({ok:true}),error=>({error:String(error)}));await entered.promise
 await control(b,'running','b-still-independent');ok('Task B control completes while A accepted write waits',(await controls.task(b.taskId)).intent,'running')
 const ended={...held,status:'complete'};await files.replace(paths.task(held.taskId),encodeJson(ended));await cleaner.clean(ended,{snapshot:{},task:ended,family:[ended],startedAt:0,status:'delete'});ok('Cleaner does not join pending original stop write',await files.entryInfo(paths.run(held.taskId)),undefined)
 release.resolve();const rejected=await pending;ok('deleted directory rejects original caller instead of fake success',!!rejected.error,true);await drain();ok('late original write does not rebuild root',await files.entryInfo(paths.run(held.taskId)),undefined);files.updateInExistingDirectory=originalUpdate
 const reopened=await task(),old={...reopened},newer={...reopened,lifecycleId:'new-life'};await control(old,'paused','old-life-pause');await files.replace(paths.task(newer.taskId),encodeJson(newer));ok('new life does not inherit old life pause',await controls.taskHeld(newer.taskId,newer.lifecycleId),false);await control(newer,'running','new-life-resume');ok('old lifecycle body remains only inside same Task file',(await controls.task(old.taskId)).intent,'paused');await assert.rejects(control(old,'running','stale-late'),/earlier lifecycle/);ok('Service rejects stale life before mutation',true,true)
 // Cold discovery enters from actual Host Task metadata observation. Existing
 // unbound SDK discovery is disabled here to measure only the known-Task path.
 const cold=await task(),coldOld=role(cold,'cold-old'),coldNow=role(cold,'cold-current');await controls.requestExecutionStop('cold-old-command',coldOld.identity);rt.roleRecords.set(coldNow.identity.workId,coldNow)
 let readCount=0,readFailure=true;const originalPending=controls.pendingTaskStops.bind(controls)
 controls.pendingTaskStops=async id=>{if(id===cold.taskId){readCount++;if(readFailure)throw Error('Exact Task control read failure')}return originalPending(id)}
 const host=new FrameworkHostLoop(files,{},storage,{member:'A',primary:true,scope:'g20-host',instanceUUID:'test-host'},()=>['A'],{startup:async()=>{},observe:async()=>rt.retryStartupControls(),executing:()=>false,wake:async()=>false,discoverTask:async task=>rt.rememberTerminalTask(task),sealBusiness:async()=>{},clean:async()=>false,releaseTask:async()=>{},error:e=>errors.push(String(e)+ (e.errors ? ": "+e.errors.map(String).join("; ") : ""))})
 await host.start();await host.poll();await until(()=>readCount>0);await drain();ok('cold failed exact read keeps original Task responsibility',rt.pendingTaskControlDiscovery.has(cold.taskId),true)
 readFailure=false;await host.poll();await drain();ok('next actual Host poll retries original known Task only',rt.pendingTaskControlDiscovery.has(cold.taskId),false);ok('cold old generation settled superseded without stopping current',(await controls.execution(coldOld.identity)).result.state,'superseded');ok('current generation remains unchanged',rt.roleRecords.get(coldNow.identity.workId).identity.executionId,'cold-current');const reads=readCount;await host.poll();await drain();ok('same lifecycle rediscovery does not reread cold control body',readCount,reads);await host.stop()
 // Closing joins this Runtime's accepted original Task-file write, without
 // claiming its native outcome or changing the original caller's UNKNOWN.
 for(const mode of ['success','unknown']){
  const closingTask=await task(),closingRole=role(closingTask,'closing-'+mode),entered=defer(),release=defer()
  const closer=Object.assign(new Runtime(),{files,controls,config:rt.config,roleRecords:new Map([[closingRole.identity.workId,closingRole]]),pendingControlStops:[],pendingTaskControlDiscovery:new Map(),startupControlsDiscovered:true,workOperations:new Map(),stopOperations:new Map(),targetedPumps:new Map(),organizerWakeWrites:new Map(),cleanupResidues:new Map(),cleaner:{close(){}},loop:{ownsPhysicalTaskCleanup:()=>false,stop:async()=>{}},observations:{dispose:async()=>{}},native:{cancelOpening:async()=>({status:'superseded'})},environment:{},error:e=>errors.push(String(e))})
  const ownService=Object.assign(new Service(),service,{running:new Map([['local',{connection:access.connection,runtime:closer}]])})
  let held=true
  files.updateInExistingDirectory=async(p,build,signal)=>{
   const result=await originalUpdate(p,async bytes=>{const result=await build(bytes);if(p===controls.taskRecordPath(closingTask.taskId)&&held){held=false;entered.resolve();await release.promise}return result},signal)
   if(p===controls.taskRecordPath(closingTask.taskId)&&mode==='unknown')throw Error('Closing original UNKNOWN after rename')
   return result
  }
  const submitted=ownService.stopExecution({mode:'local',commandId:'closing-'+mode,workId:closingRole.identity.workId,executionId:closingRole.identity.executionId}).then(value=>({value}),error=>({error:String(error)}));await entered.promise
  let done=false;const disposal=closer.dispose().then(()=>done=true);await tick();ok(mode+' close retains accepted Task write before storage release',done,false)
  release.resolve();const outcome=await submitted;await disposal;files.updateInExistingDirectory=originalUpdate
  ok(mode+' close completed only after original write settled',done,true)
  ok(mode+' original caller result unchanged',mode==='success'?outcome.value?.submitted:outcome.error,mode==='success'?true:'Error: Closing original UNKNOWN after rename')
  const retained=await controls.execution(closingRole.identity);ok(mode+' accepted owner remains pending for exact cold discovery',retained.result,undefined)
  ok(mode+' request still discoverable in the actual Task file',(await controls.pendingTaskStops(closingTask.taskId)).some(x=>x.executionId===closingRole.identity.executionId),true)
 }
 // Independent no-Task executions deliberately remain on their existing owner.
 const unbound={workId:'Foreground',executionId:'fg'};await controls.requestExecutionStop('fg-stop',unbound);ok('no-Task execution remains independent SDK owner',!!await controls.execution(unbound),true);ok('Task paths never receive Foreground execution',Object.values((await withSnapshot(files,s=>readJson(files,s,oa))).executions).length,0)
 console.log(JSON.stringify({status:'passed',assertions:checks.length,checks,expectedErrors:errors,cost,events,boundaries:['Real SDK/files/controls/Host polling, extracted real Service and Runtime methods','Native stop and resume scheduling are explicit ports; generation inputs already stopped','No remote Git or model execution in this test'],...evidence()},null,2))
} catch(error) { console.error(JSON.stringify({checks,errors,events,sourceHashes:evidence().sourceHashes},null,2)); throw error } finally {await files.close();await sdk.close();supplemental.deregister();hooks.deregister();await fs.rm(temp,{recursive:true,force:true})}
