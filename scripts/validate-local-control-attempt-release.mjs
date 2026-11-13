import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createRequire,registerHooks,stripTypeScriptTypes} from 'node:module'
import {pathToFileURL} from 'node:url'
import {sourceRoot,sdkHostRoot,hash,hooks,evidence,loaded} from './test-support/dsh-sdk-runtime.mjs'
import {openDshStorageFixture} from './test-support/dsh-sdk-storage.mjs'
const supplemental=registerHooks({resolve(s,c,next){if(s==='mdast-util-from-markdown')return{url:'data:text/javascript,export function fromMarkdown(text){if(text.includes("["))throw new Error("Markdown links outside this control test");return {type:"root",children:[]}}',shortCircuit:true};return next(s,c)},load(u,c,next){if(u===new URL('framework/skills.ts',sourceRoot).href)return{format:'module',source:'export const frameworkSkillIndexPath="skills/index.md";export function createFrameworkSkillIndexInitialization(){return ()=>{throw new Error("Skill initialization is outside the control close test")}}export function isFrameworkSkillDefinitionPath(){throw new Error("Skills outside wake test")};export function prepareFrameworkSkillIndex(){throw new Error("Skills outside wake test")}',shortCircuit:true};return next(u,c)}})
const require=createRequire(pathToFileURL(path.join(sdkHostRoot,'wake-audit.mjs')))
const {JsonStorageBackend}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-storage-json')).href)
const {DshStorageAdapter}=await import('../src/adapters/dsh/storage.ts')
const {PhysicalLocalFiles,LocalTaskRecordParentMissing}=await import('../src/framework/physical-local-files.ts')
const {GitAuthorityStore,listAuthorityInRound}=await import('../src/framework/git-authority.ts')
const {withSnapshot,withOperationChannel}=await import('../src/framework/transactions.ts')
const {preparePhysicalTask,paths,readJson,taskLifecycle,taskLifecycleKey,foregroundTaskSignal,isTerminalTask,encodeJson,assertTaskLifecycle}=await import('../src/framework/task-files.ts')
const {readTaskReferenceIdentity,taskHistoryChange,readTaskHistoryIdentity}=await import('../src/framework/task-history.ts')
const {taskArchiveHostKey,taskArchiveHostFacts,readTaskArchiveState,updateTaskArchiveState,taskArchiveLifecycle}=await import('../src/framework/task-archive.ts')
const {installFrameworkRoleTools,parseDirectSignal}=await import('../src/framework/role-tools.ts')
const {helperSignalWakeHash}=await import('../src/framework/host-loop.ts')
const {cancelPhysicalTask}=await import('../src/framework/physical-task-terminal.ts')
const runtimeSource=readFileSync(new URL('framework/role-runtime.ts',sourceRoot),'utf8');loaded.set('framework/role-runtime.ts',hash(runtimeSource))
const js=stripTypeScriptTypes(runtimeSource,{mode:'transform'})
const method=name=>{const m=new RegExp('\\n    (?:async )?'+name+'\\(').exec(js);assert(m,name);const start=m.index+1,next=/\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(js.slice(start+m[0].length));if(!next){assert.equal(name,'disposeOwned');return js.slice(start,js.lastIndexOf('\n}'))}return next?js.slice(start,start+m[0].length+next.index):js.slice(start,js.lastIndexOf('\n}'))}
const {localForegroundRoleRecordPath}=await import('../src/framework/conversation.ts')
const {taskFamily}=await import('../src/framework/task-relations.ts')
const {retireNativeSession}=await import('../src/adapters/dsh/native-cleaner.ts')
const {ExecutionObservations}=await import('../src/framework/execution-observation.ts')
const {FrameworkHostLoop}=await import('../src/framework/host-loop.ts')
const {FrameworkCleaner,observeCleanup}=await import('../src/framework/cleaner.ts')
const {retirePublishedPhysicalRecovery}=await import('../src/framework/physical-recovery.ts')
const deps={localForegroundRoleRecordPath,retireNativeSession,retirePublishedPhysicalRecovery,taskFamily,annotateFailure:e=>e,DshStorageAdapter,PhysicalLocalFiles,LocalTaskRecordParentMissing,GitAuthorityStore,listAuthorityInRound,withSnapshot,withOperationChannel,paths,readJson,taskLifecycle,taskLifecycleKey,foregroundTaskSignal,readTaskReferenceIdentity,taskArchiveHostKey,taskArchiveHostFacts,readTaskArchiveState,parseDirectSignal,helperSignalWakeHash,isTerminalTask,encodeJson,hash,assertTaskLifecycle,updateTaskArchiveState,taskArchiveLifecycle}
const {ExecutionControls}=await import('../src/framework/execution-control.ts')
const {openFrameworkConnection,openFrameworkStorage}=await import('../src/framework/connection.ts')
const {disposeResources}=await import('../src/framework/dispose-resources.ts')
const {z}=await import(pathToFileURL(require.resolve('zod')).href)
const names=['forgetAdmissionWake','localTaskRetirementRows','sealBusiness','withTaskFacts','currentTask','trackedStop','saveRole','saveRoleInChannel','assertOrganizerBusiness','roleKey','roleRecordPath','taskRuntimeReleased','taskSealAt','archiveHostKey','continueNativeRetirements','releaseTask','commitTaskSeal','cleanupWorkerTransfers','executionViews','requestExecutionStop','arrangeNativeContinuation','applyUserControls','serialWork','releaseLocalTask','retireTaskRuntime','taskReleaseWakes','withRoleWrite','deleteRuntimeRecord','watchKey','serialRecoveryWatch','restoreTaskOwner','retirePhysicalRestoreDebug','retryStartupControls','startMaintenance','dispose','disposeOwned','cancelledByShutdown','settleOperations']
const Runtime=new Function(...Object.keys(deps),'return class {\n'+names.map(method).join('\n')+'\n}')(...Object.values(deps))

const baseline=process.argv.includes('--baseline')
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'dss-control-final-release-')),checks=[],events=[]
const check=(name,value,expected)=>{assert.deepEqual(value,expected,name);checks.push({name,value})}
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
const tick=()=>new Promise(setImmediate),until=async f=>{const deadline=performance.now()+5000;for(;;){if(await f())return;if(performance.now()>=deadline)throw Error('Controlled boundary timed out');await new Promise(resolve=>setTimeout(resolve,1))}}
const nativeOpen=JsonStorageBackend.prototype.openUnit;let holdKey,entered,release,observeRoot
JsonStorageBackend.prototype.openUnit=async function(...args){const unit=await nativeOpen.apply(this,args);if(args[0].name==='record'){const put=unit.putRecord.bind(unit);unit.putRecord=async(t,k,v)=>{if(k.startsWith(observeRoot??'no-prefix'))events.push({event:'native-put',key:k});if(k===holdKey){entered.resolve();await release.promise}return put(t,k,v)}}return unit}
const sourceService=readFileSync(new URL('framework/service.ts',sourceRoot),'utf8'),serviceJs=stripTypeScriptTypes(sourceService,{mode:'transform'});loaded.set('framework/service.ts',hash(sourceService))
const extract=(js,name)=>{const m=new RegExp('\\n    (?:async )?'+name+'\\(').exec(js),start=m.index+1,next=/\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(js.slice(start+m[0].length));return next?js.slice(start,start+m[0].length+next.index):js.slice(start,js.lastIndexOf('\n}'))}
const Service=new Function('withOperationChannel','z','disposeResources','PhysicalLocalFiles','ExecutionControls','return class {\n'+['controls','stopExecution','checkScope','access','assertOpen','serialMode','participation','stopRunning','stopManualCleanup','dispose','closeAccess'].map(n=>extract(serviceJs,n)).join('\n')+'\n}')(withOperationChannel,z,disposeResources,PhysicalLocalFiles,ExecutionControls)
let serial=0
async function fixture(role,registered=false,child=false){
 const dir=path.join(temp,String(++serial)),sdk=await openDshStorageFixture(path.join(dir,'records'),path.join(dir,'locator')),store=sdk.adapter,connection=registered?await openFrameworkConnection({mode:'local',directory:path.join(dir,'local'),login:'A',workerSeats:0},{storage:store}):undefined,files=connection?.files??new PhysicalLocalFiles(path.join(dir,'local')),scope=connection?.scope??'final-release-'+serial,prefix='framework-runtime/'+hash(scope)+'/',root='framework-user-controls/'+hash(scope),taskId='60000000-0000-4000-8000-000000000001',instanceUUID='60000000-0000-4000-8000-000000000099';let clock=0
 const controls=new ExecutionControls(store,scope,()=>String(++clock),files,store,instanceUUID)
 const source='tasks/task_'+(role==='Organizer'?'O':'P')+'.md';await files.replace(source,'Existing completed Task');const task=await withSnapshot(files,s=>preparePhysicalTask(files,s,source,{taskId,owner:'A',members:['A']}));let terminal
 const observations=new ExecutionObservations(store,{arrange(){throw Error('No live observation')}},()=>{})
 const errors=[],nativeRetirements=[],journalEnter=defer(),journalRelease=defer();let holdJournal=false
 sdk.ctx.provide('nativeSessionCleaner',{retire:async id=>{nativeRetirements.push(id);if(holdJournal){journalEnter.resolve();await journalRelease.promise}}})
 const rt=Object.assign(new Runtime(),{ctx:sdk.ctx,files,records:store,prefix,controls,observations,config:{scope,collaborationId:scope,mode:'local',member:'A',instanceUUID},localWakeAdmissions:new Map(),admissionObservationVersion:0,reportedAdmissionDiagnostics:new Set(),admissionNow:()=>Date.now(),roleRecords:new Map(),roleBases:new Map(),roleWriteOwners:new Map(),wakeConsumptions:new Map(),cleanupResidues:new Map(),resolvedSafetyFaultIds:new Set(),retiredWorkers:new Map(),workOperations:new Map(),pendingControlStops:[],pendingTaskControlDiscovery:new Map(),startupControlsDiscovered:true,ownedAsyncContext:f=>f(),safetyCommandFor:()=>undefined,environment:{},error(e){errors.push(String(e))},active:()=>false,wakeWrites:new Map(),wakeWriteOwners:new Map(),observationRecordWrites:new Map(),restoreWriteOwners:new Map(),safetyRestoreWrites:new Map()})
 const workId=rt.roleKey(role,taskId);let old={identity:{role,taskId,...(role==='Planner'?{member:'A'}:{}),workId,executionId:'final-execution',lifecycleId:task.lifecycleId},sessionId:'final-native-session',generation:3,stopped:false}
 await rt.saveRole(old)
 const completeTools=new Map(),completeAgent={id:'complete-'+serial,session:{}},completeContext={on:()=>()=>{},effect:()=>{},systemPrompt:{section(){}},tools:{register:t=>completeTools.set(t.name,t)}}
 installFrameworkRoleTools(completeContext,completeAgent,{...old.identity,owner:'A',member:'A'},{files,notifications:async()=>[],claimNotifications:async()=>({signals:[]}),transact:async()=>{throw Error('No generic transaction')},onError:e=>{throw e}})
 const completeCall=async(name,input)=>{const tool=completeTools.get(name);return tool.execute(tool.parameters?.parse?tool.parameters.parse(input):input,{agent:completeAgent,callId:name+'-'+serial,signal:new AbortController().signal,concludeTurn(){events.push({event:'complete-concluded',role})}})}
 await files.replace(paths.run(taskId)+'/evidence.md','Original accepted evidence')
 if(child){
  const dispatchView=await completeCall('dss_snapshot',{});await completeCall('dss_planner_dispatch',{snapshotId:dispatchView.snapshotId,objectiveId:'real-child',member:'A',route:'P',plan:'Actual child objective.',decision:'Actual root allocation.'})
  const rootAfter=await withSnapshot(files,s=>readJson(files,s,paths.task(taskId))),childTask=await withSnapshot(files,s=>readJson(files,s,paths.task(rootAfter.children[0].taskId)))
  old={identity:{role:'Planner',taskId:childTask.taskId,member:'A',workId:rt.roleKey('Planner',childTask.taskId),executionId:'child-execution'},sessionId:'child-native-session',generation:1,stopped:false};await rt.saveRole(old)
  const childTools=new Map(),childAgent={id:'child-planner-'+serial,session:{}},childCtx={on:()=>()=>{},effect:()=>{},systemPrompt:{section(){}},tools:{register:t=>childTools.set(t.name,t)}}
  installFrameworkRoleTools(childCtx,childAgent,{...old.identity,owner:'A'},{files,notifications:async()=>[],claimNotifications:async()=>({signals:[]}),transact:async()=>{throw Error('No generic transaction')},onError:e=>{throw e}})
  const childCall=async(name,input)=>{const tool=childTools.get(name);return tool.execute(tool.parameters?.parse?tool.parameters.parse(input):input,{agent:childAgent,callId:name+'-'+serial,signal:new AbortController().signal,concludeTurn(){}})}
  const childView=await childCall('dss_snapshot',{});await childCall('dss_complete',{snapshotId:childView.snapshotId,acceptance:'Actual completed child objective.',resultPaths:[]})
  check('actual dispatched child is completed',(await withSnapshot(files,s=>readJson(files,s,paths.task(childTask.taskId)))).status,'complete')
 }
 const completeView=await completeCall('dss_snapshot',{});await completeCall('dss_complete',{snapshotId:completeView.snapshotId,acceptance:'Accepted actual evidence.',resultPaths:[paths.run(taskId)+'/evidence.md']})
 terminal=await withSnapshot(files,s=>readJson(files,s,paths.task(taskId)))
 check(role+' actual dss_complete writes total completion',terminal.status,'complete')
 const recorderWakes=[]
 const cleaner=new FrameworkCleaner(files,{}),host=new FrameworkHostLoop(files,{},store,{member:'A',primary:true,scope,instanceUUID},()=>['A'],{executing:()=>false,wake:async request=>{recorderWakes.push(request);return true},sealBusiness:task=>rt.sealBusiness(task.taskId,task.lifecycleId),cancelledBusinessStopped:async()=>{throw Error('Normal complete must not enter cancellation gate')},releaseTask:(...args)=>rt.releaseLocalTask(...args),clean:async(task,_snapshot,observation)=>(await cleaner.clean(task,observation)).status==='released',error:e=>errors.push(String(e))})
 rt.loop=host
 await withSnapshot(files,s=>host.scanTask(terminal,s,performance.now()))
 check(role+' actual Host admits original Recorder notice',recorderWakes.map(w=>w.role),['Recorder'])
 check(role+' admitted Recorder matches completed Task',recorderWakes[0].taskId,taskId)
 check(role+' original manager need not have native stop proof before Recorder admission',rt.roleRecords.get(workId).stopped,false)
 // Actual registered Recorder validates the terminal Task and produces Cleaner.
 const registeredTools=new Map(),agent={id:'recorder-'+serial,session:{}},ctx={on:()=>()=>{},effect:()=>{},systemPrompt:{section(){}},tools:{register:tool=>registeredTools.set(tool.name,tool)}}
 installFrameworkRoleTools(ctx,agent,{role:'Recorder',taskId,owner:'A',member:'A',workId:'recorder-'+taskId,executionId:'recorder-'+serial},{files,notifications:async()=>[],claimNotifications:async()=>({signals:[]}),transact:async()=>{throw Error('No generic Local transaction')},onError:e=>{throw e}})
 const call=async(name,input)=>{const tool=registeredTools.get(name);return tool.execute(tool.parameters?.parse?tool.parameters.parse(input):input,{agent,callId:name+'-'+serial,signal:new AbortController().signal,concludeTurn(){}})}
 const view=await call('dss_snapshot',{});const result=await call('dss_recorder_save',{snapshotId:view.snapshotId,outputs:[{path:view.archiveRecordsPath,text:'Actual normally completed Task final record.'}],retainedPaths:[]})
 check(role+' actual Recorder save succeeds',result.saved,true)
 check(role+' actual Recorder publishes original Cleaner',await withSnapshot(files,s=>files.read(s,paths.state('A',taskId)+'/Cleaner')),'')
 const key=taskLifecycleKey(terminal)
 const access={connection:{scope,files,records:store,sharedRecords:store,identity:{instanceUUID}}},service=Object.assign(new Service(),{access:async()=>access,running:new Map([['local',{connection:access.connection,runtime:rt}]])})
 const request=commandId=>service.stopExecution({mode:'local',storageScope:scope,commandId,workId:old.identity.workId,executionId:old.identity.executionId})
 return {sdk,store,files,connection,rt,controls,host,cleaner,requestService:service,task:terminal,key,root,prefix,old,request,errors,nativeRetirements,holdJournal(){holdJournal=true},journalEnter,journalRelease,close:async()=>{journalRelease.resolve();while(controls.writes.size)await Promise.allSettled([...controls.writes.values()]);while(rt.maintenance?.size){await Promise.allSettled([...rt.maintenance.values()]);await tick()}await Promise.allSettled([...host.physicalReleaseOperations.values()]);cleaner.close();await connection?.close();await files.close();await sdk.close()}}
}
try {
  {
   const f=await fixture('Planner',true)
   const releaseClose=defer()
   try {
    // Actual public participation(false) owns runtime.dispose and connection.close.
    // Hold only the end of the real PhysicalLocalFiles.close, after it has closed
    // its own files, to expose the genuine stopRunning -> running.delete window.
    const frontConnection=await openFrameworkStorage({mode:'local',directory:f.files.directory,login:'A',workerSeats:0},{storage:f.store}),front={connection:frontConnection,conversation:{scope:{mode:'local'}}},service=f.requestService
    check('Actual frontend Access and Running use distinct Physical file handles',frontConnection.files!==f.files,true)
    await f.controls.requestExecutionStop('prior-durable-stop',f.old.identity)
    await f.controls.requestExecutionStop('prior-different-signature',{...f.old.identity,executionId:'previous-original-execution'})
    delete service.access
    Object.assign(service,{storage:f.store,closed:false,moveError:()=>undefined,accessTransitions:new Map(),accesses:new Map([['local',Promise.resolve(front)]]),accessOpening:new Map(),backgroundOpening:new Map(),configurationOwners:new Set(),modeConfiguration:new Map(),settingsCommands:new Map(),modeSending:new Map(),stopping:new WeakMap(),gitUpgrades:new Map(),running:new Map([['local',{connection:f.connection,runtime:f.rt}]]),changed:()=>{},settingsView:async()=>({mode:'local'})})
    Object.assign(f.rt,{loop:f.host,cleaner:f.cleaner,targetedPumps:new Map(),organizerWakeWrites:new Map(),native:{cancelOpening:async()=>({status:'superseded'})}})
    const writeEntered=defer(),writeRelease=defer(),writeUnknown=new Error('Original write UNKNOWN during actual participation'),update=f.files.updateInExistingDirectory.bind(f.files)
    f.files.updateInExistingDirectory=async(...args)=>{const result=await update(...args);if(args[0]===f.controls.taskRecordPath(f.task.taskId)){writeEntered.resolve();await writeRelease.promise;throw writeUnknown}return result}
    const original=f.request('original-close-unknown').then(value=>({value}),error=>({error}));await writeEntered.promise
    await f.rt.saveRole({...f.old,stopped:true,released:true})
    const close=f.files.close.bind(f.files),closingSeen=defer();let closeCalls=0,storeCloses=0
    f.files.close=async()=>{closeCalls++;await close();closingSeen.resolve();await releaseClose.promise}
    const storageClose=f.store.close.bind(f.store);f.store.close=()=>{storeCloses++;return storageClose()}
    let disableDone=false;const disabling=service.participation({mode:'local',enabled:false}).finally(()=>disableDone=true)
    await until(()=>f.rt.closed===true)
    let retryDone=false;const originalRetry=f.request('original-close-unknown').then(value=>({value}),error=>({error})).finally(()=>retryDone=true)
    await tick();check('Actual participation waits its already accepted original write',disableDone,false)
    check('Same-command retry during disposal still waits original write',retryDone,false)
    writeRelease.resolve();const originalOutcomes=await Promise.all([original,originalRetry])
    check('Independent Access never substitutes success for original UNKNOWN',originalOutcomes.map(x=>x.error===writeUnknown),[true,true])
    f.files.updateInExistingDirectory=update;await closingSeen.promise
    check('Public participation window has truly disposed runtime',f.rt.closed,true)
    check('Public participation window still owns Running until connection close completes',service.running.has('local'),true)
    check('Local connection close does not close plugin-owned record storage',storeCloses,0)
    check('Real Local connection retains the original SDK record adapter',f.connection.records===f.store,true)
    let controlReads=0;const get=f.store.get.bind(f.store);f.store.get=async k=>{if(k.startsWith(f.root))controlReads++;return get(k)}
    const lateResult=await f.request('during-participation-close').then(value=>({value}),error=>({error:String(error)}));check('Actual released stop during connection-close succeeds',lateResult.value?.submitted,true)
    check('Same accepted command uses surviving Access after Running close',(await f.request('prior-durable-stop')).submitted,true)
    await assert.rejects(f.request('prior-different-signature'),/different arguments/);check('Service callback retains different-signature failure after Running close',true,true)
    const originalLate=await f.request('original-close-unknown').then(value=>({value}),error=>({error}))
    check('Retained original UNKNOWN remains exact during actual connection close',originalLate.error===writeUnknown,true)
    const frontControls=new ExecutionControls(frontConnection.sharedRecords,frontConnection.scope,undefined,frontConnection.files,frontConnection.records,frontConnection.identity.instanceUUID)
    await frontControls.acknowledgeLocalReleasedExecutionStop('prior-durable-stop',f.old.identity);check('Existing independent Access still reads original accepted Task command',true,true)
    await assert.rejects(frontControls.acknowledgeLocalReleasedExecutionStop('prior-durable-stop',{...f.old.identity,executionId:'different-execution'}),/different arguments/);check('Existing Access still preserves original signature conflict',true,true)
    check('Original runtime disposal promise already completed before Running files close',await f.rt.disposing,undefined)
    // A captured frontend from another configuration is never a signature
    // authority for this old Running. The fallback stays the original reader.
    const frontSaved=service.accesses.get('local'),other=await openFrameworkStorage({mode:'local',directory:path.join(temp,'other-config'),login:'A',workerSeats:0},{storage:f.store})
    let otherReads=0;const otherRead=other.files.readBytes.bind(other.files);other.files.readBytes=(...args)=>{otherReads++;return otherRead(...args)}
    service.accesses.set('local',Promise.resolve({connection:other,conversation:{scope:{mode:'local'}}}))
    const mismatch=await service.stopExecution({mode:'local',workId:f.old.identity.workId,executionId:f.old.identity.executionId,commandId:'scope-mismatch-late'}).then(value=>({value}),error=>({error:String(error)}))
    check('Different Access scope never becomes old Running signature authority',otherReads,0)
    check('Mismatched scope retains original closed-reader error',mismatch.error,'Error: Physical Local storage is closed.')
    service.accesses.set('local',frontSaved);await other.close()

    check('Late query does not alter original owner command',(await frontControls.execution(f.old.identity)).commandId,'original-close-unknown')
    releaseClose.resolve();await disabling
    check('Participation removes Running only after actual connection close',service.running.has('local'),false)
    check('Connection close ran once before harmless late read',closeCalls,1)
    check('Records remain readable after participation disconnect',await f.store.get('framework-participation/local'),false)
    // Plugin shutdown invokes service.dispose before storage.close. Test the
    // real closed access guard, not a direct call to an already disposed runtime.
    Object.assign(service,{localUpgrades:new Map(),opening:new Map(),writePreparations:new Set(),relocationOwners:new Map(),listeners:new Set(),disposalErrors:[],cleanupFailure(_mode,error){this.disposalErrors.push(error)}})
    await service.dispose();const readsBefore=controlReads
    const late=await f.request('after-service-disposed').then(value=>({value}),error=>({error}))
    check('Actual Service access rejects requests after service disposal',late.error?.message,'Framework service is disposed.')
    check('Rejected post-service call does not read or reopen controls',controlReads,readsBefore)
    check('Service disposal does not close plugin-owned records',storeCloses,0)
    check('No hidden connection-window error',f.errors,[])
   }finally{releaseClose.resolve();await f.close()}
  }

 // Three original calls were already accepted before the real Cleaner was
 // observed. Keep the actual file until those original reads finish, so this
 // checks propagation of a controlled UNKNOWN, not an observed production fault or an SDK split-claim stage.
 {
  const f=await fixture('Planner'),entered=defer(),release=defer(),thirdEntered=defer(),thirdRelease=defer(),cleanEntered=defer(),cleanRelease=defer(),clean=f.host.actions.clean;let cleanStarted=false
  const update=f.files.updateInExistingDirectory.bind(f.files),unknown=new Error('Third original command read UNKNOWN');let attempts=0
  try {
   f.rt.stopOwnedRecord=async()=>({status:'stopped'})
   f.files.updateInExistingDirectory=async(p,decide,signal,coordinateRemoval)=>{const own=p===f.controls.taskRecordPath(f.task.taskId),n=own?++attempts:0;const value=await update(p,decide,signal,coordinateRemoval);if(n===1){entered.resolve();await release.promise}if(n===3){thirdEntered.resolve();await thirdRelease.promise;throw unknown};return value}
   const original=[f.request('three-original').then(value=>({value}),error=>({error}))];await entered.promise
   original.push(f.request('three-original').then(value=>({value}),error=>({error})));original.push(f.request('three-original').then(value=>({value}),error=>({error})));await thirdEntered.promise
   f.host.actions.clean=async(...args)=>{cleanStarted=true;cleanEntered.resolve();await cleanRelease.promise;return clean(...args)}
   const cleaning=withSnapshot(f.files,s=>f.host.scanTask(f.task,s,performance.now()))
   await until(()=>f.rt.roleRecords.get(f.old.identity.workId)?.released===true)
   await tick();check('Cleaner is admitted without waiting for unrelated native release',cleanStarted,true)
   check('Three previously accepted original calls retain separate promises',f.rt.pendingControlStops.length,3)
   let retryDone=false;const retry=f.request('three-original').then(value=>({value}),error=>({error})).finally(()=>retryDone=true)
   await tick();check('Released same-command retry waits the latest original attempt',retryDone,false)
   release.resolve();thirdRelease.resolve();const [first,second,third]=await Promise.all(original),late=await retry
   check('First original atomic submission retains success',first.value?.submitted,true);check('Second identical original read retains success',second.value?.submitted,true)
   check('Third original UNKNOWN remains the actual error',third.error===unknown,true);check('Immediate retry cannot substitute earlier success for latest UNKNOWN',late.error===unknown,true)
   await until(()=>cleanStarted);cleanRelease.resolve();await cleaning;await until(()=>!f.host.physicalReleaseOperations.size)
   for(let n=0;n<4;n++){f.rt.retryStartupControls();while(f.rt.maintenance?.size){await Promise.allSettled([...f.rt.maintenance.values()]);await tick()}}
   check('Real original maintenance retires all three attempt objects',f.rt.pendingControlStops,[])
   check('Whole Task deletion removes the one control file',await f.controls.execution(f.old.identity),undefined)
   check('No original completion can recreate Task directory',await f.files.entryInfo(paths.run(f.task.taskId)),undefined)
   check('Caller UNKNOWN is not made a resource shutdown error',f.errors,[])
  } finally {release.resolve();thirdRelease.resolve();cleanRelease.resolve();f.host.actions.clean=clean;f.files.updateInExistingDirectory=update;await f.close()}
 }
 // Original accepted command tail is shared by the two existing control
 // facades, while a new unrelated command need not wait that execution owner.
 {
  const f=await fixture('Planner'),entered=defer(),release=defer(),update=f.files.updateInExistingDirectory.bind(f.files)
  try {
   f.files.updateInExistingDirectory=(p,decide,signal,coordinateRemoval)=>update(p,async bytes=>{const decision=await decide(bytes);if(p===f.controls.taskRecordPath(f.task.taskId)){entered.resolve();await release.promise}return decision},signal,coordinateRemoval)
   const accepted=f.controls.requestExecutionStop('owned-command-tail',f.old.identity);await entered.promise
   await f.rt.saveRole({...f.old,stopped:true,released:true})
   let controlLists=0;const originalList=f.store.list.bind(f.store);f.store.list=(...args)=>{controlLists++;return originalList(...args)}
   let done=false;const same=f.request('owned-command-tail').finally(()=>done=true);await tick();await tick()
   check('Released exact command waits original command tail without Runtime attempt object',done,false)
   check('New harmless command does not wait another accepted execution write',(await f.request('new-unrelated-command')).submitted,true)
   release.resolve();await accepted;check('Original tail is accepted before same-command acknowledgement',(await same).submitted,true)
   check('Original control body remains intact',(await f.controls.execution(f.old.identity)).commandId,'owned-command-tail')
   check('Released exact acknowledgement adds no prefix enumeration',controlLists,0)
  } finally {release.resolve();f.files.updateInExistingDirectory=update;await f.close()}
 }
 // An already accepted result write holds same-Task release before Cleaner.
 // Once that exact settlement completes, cleanup may remove the Task without
 // a late writer recreating its control directory or leaving an old attempt.
 {
  const f=await fixture('Planner'),entered=defer(),release=defer(),update=f.files.updateInExistingDirectory.bind(f.files);let held=false
  try {
   await f.rt.saveRole({...f.old,stopped:true})
   f.files.updateInExistingDirectory=(p,decide,signal,coordinateRemoval)=>update(p,async bytes=>{const decision=await decide(bytes)
    if(!held&&p===f.controls.taskRecordPath(f.task.taskId)&&decision.content&&Object.values(JSON.parse(decision.content).executions).some(x=>x.result)){held=true;entered.resolve();await release.promise}return decision},signal,coordinateRemoval)
   await f.request('settle-before-cleaner');await entered.promise
   const cleanup=withSnapshot(f.files,s=>f.host.scanTask(f.task,s,performance.now()));await tick()
   check('Accepted settlement keeps its directory while the same-file operation runs',Boolean(await f.files.entryInfo(paths.run(f.task.taskId))),true)
   check('Original pending attempt remains owned while settlement waits',f.rt.pendingControlStops.some(x=>x.commandId==='settle-before-cleaner'),true)
   await until(()=>f.host.physicalReleaseOperations.size>0)
   check('Same-Task native release is still active while settlement waits',f.host.physicalReleaseOperations.size>0,true)
   release.resolve();await cleanup;await until(()=>!f.host.physicalReleaseOperations.size)
   await until(async()=>!await f.files.entryInfo(paths.run(f.task.taskId)))
   while(f.rt.maintenance?.size){await Promise.allSettled([...f.rt.maintenance.values()]);await tick()}
   check('Original settlement completes without maintenance failure',f.errors,[])
   check('Result write cannot recreate the Task root',await f.files.entryInfo(paths.run(f.task.taskId)),undefined)
   f.rt.retryStartupControls();while(f.rt.maintenance?.size){await Promise.allSettled([...f.rt.maintenance.values()]);await tick()}
   check('Original exact attempt retires after resource cleanup',f.rt.pendingControlStops,[])
  } finally {release.resolve();f.files.updateInExistingDirectory=update;await f.close()}
 }
 // Real runtime disposal waits accepted original writes, while their caller
 // keeps exact success or UNKNOWN. New Task files have no claim-only phase.
 for(const failure of ['success','before-publication-error','after-publication-unknown']) {
  const f=await fixture('Planner'),entered=defer(),release=defer(),update=f.files.updateInExistingDirectory.bind(f.files),originalError=new Error(failure);let first=true
  try {
   await f.rt.saveRole({...f.old,stopped:true})
   Object.assign(f.rt,{loop:f.host,cleaner:f.cleaner,targetedPumps:new Map(),organizerWakeWrites:new Map(),native:{cancelOpening:async()=>({status:'superseded'})}})
   f.files.updateInExistingDirectory=async(p,decide,signal,coordinateRemoval)=>{if(p!==f.controls.taskRecordPath(f.task.taskId)||!first)return update(p,decide,signal,coordinateRemoval);first=false
    if(failure==='before-publication-error')return update(p,async bytes=>{const result=await decide(bytes);entered.resolve();await release.promise;throw originalError},signal,coordinateRemoval)
    const result=await update(p,decide,signal,coordinateRemoval);entered.resolve();await release.promise;if(failure==='after-publication-unknown')throw originalError;return result}
   const original=f.request('close-original-'+failure).then(value=>({value}),error=>({error}));await entered.promise
   let closed=false;const closing=f.rt.dispose().finally(()=>closed=true);await tick();await tick();check(failure+' dispose waits accepted original write',closed,false)
   release.resolve();const outcome=await original;await closing
   check(failure+' original caller retains exact outcome',failure==='success'?outcome.value?.submitted:outcome.error===originalError,true)
   check(failure+' shutdown completes without rewriting original outcome',closed,true)
   const pending=await f.controls.pendingTaskStops(f.task.taskId)
   check(failure+' cold exact Task read reflects actual atomic acceptance',pending.some(row=>row.commandId==='close-original-'+failure),failure!=='before-publication-error')
   check(failure+' no resource shutdown error substitutes for caller error',f.errors,[])
  } finally {release.resolve();f.files.updateInExistingDirectory=update;await f.close()}
 }

 console.log(JSON.stringify({status:'passed-physical-original-attempt-release',assertions:checks.length,checks,events,...evidence(),limits:'Actual SDK/files/Service and Runtime methods, actual registered complete→Host Recorder admission→Recorder save fixture. Native open/stop and journal acknowledgement are explicit ports, not a live model. Valid old attempt-release responsibilities are now tested on one atomic Task file; Task SDK split-claim and claim-before-owner deletion scenarios no longer exist. Existing noTask SDK claim-only remains in validate-local-control-observation. Separate validate-g20-control-cleanup-stop proves root/child late stops and exact original UNKNOWN/signatures through actual Cleaner. This script retains actual participation(false), separate frontend Access/Running lifetimes and service disposal; the different-scope selection is a controlled capture boundary, not a full configure invocation.'},null,2))
} finally {holdKey=undefined;release?.resolve();JsonStorageBackend.prototype.openUnit=nativeOpen;supplemental.deregister();hooks.deregister();await fs.rm(temp,{recursive:true,force:true})}
