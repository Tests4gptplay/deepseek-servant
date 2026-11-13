import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createRequire,registerHooks,stripTypeScriptTypes} from 'node:module'
import {pathToFileURL} from 'node:url'
import {sourceRoot,sdkHostRoot,hash,hooks,evidence,loaded} from './test-support/dsh-sdk-runtime.mjs'
import {openDshStorageFixture} from './test-support/dsh-sdk-storage.mjs'
const supplemental=registerHooks({resolve(s,c,next){if(s==='mdast-util-from-markdown')return{url:'data:text/javascript,export function fromMarkdown(){throw new Error("Markdown is outside this wake test")}',shortCircuit:true};return next(s,c)},load(u,c,next){if(u===new URL('framework/skills.ts',sourceRoot).href)return{format:'module',source:'export const frameworkSkillIndexPath="skills/index.md";export function createFrameworkSkillIndexInitialization(){return ()=>{throw new Error("Skill initialization outside this test")}}export function isFrameworkSkillDefinitionPath(){throw new Error("Skills outside wake test")};export function prepareFrameworkSkillIndex(){throw new Error("Skills outside wake test")}',shortCircuit:true};return next(u,c)}})
const require=createRequire(pathToFileURL(path.join(sdkHostRoot,'wake-audit.mjs')))
const {JsonStorageBackend}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-storage-json')).href)
const {DshStorageAdapter}=await import('../src/adapters/dsh/storage.ts')
const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {GitAuthorityStore,listAuthorityInRound}=await import('../src/framework/git-authority.ts')
const {withSnapshot,withOperationChannel}=await import('../src/framework/transactions.ts')
const {preparePhysicalTask,paths,readJson,taskLifecycle,taskLifecycleKey,foregroundTaskSignal,isTerminalTask,encodeJson}=await import('../src/framework/task-files.ts')
const {readTaskReferenceIdentity,taskHistoryChange,readTaskHistoryIdentity}=await import('../src/framework/task-history.ts')
const {taskArchiveHostKey,taskArchiveHostFacts,readTaskArchiveState}=await import('../src/framework/task-archive.ts')
const {parseDirectSignal}=await import('../src/framework/role-tools.ts')
const {helperSignalWakeHash}=await import('../src/framework/host-loop.ts')
const runtimeSource=readFileSync(new URL('framework/role-runtime.ts',sourceRoot),'utf8');loaded.set('framework/role-runtime.ts',hash(runtimeSource))
const revised=runtimeSource.includes('Native journal acceptance does not authorize using a closed connection.')
const js=stripTypeScriptTypes(runtimeSource,{mode:'transform'})
const method=name=>{const m=new RegExp('\\n    (?:async )?'+name+'\\(').exec(js);assert(m,name);const start=m.index+1,next=/\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(js.slice(start+m[0].length));if(!next){assert.equal(name,'disposeOwned');return js.slice(start,js.lastIndexOf('\n}'))}return js.slice(start,start+m[0].length+next.index)}
const {taskFamily}=await import('../src/framework/task-relations.ts')
const {retireNativeSession}=await import('../src/adapters/dsh/native-cleaner.ts')
const {ExecutionObservations}=await import('../src/framework/execution-observation.ts')
const {FrameworkHostLoop}=await import('../src/framework/host-loop.ts')
const {FrameworkCleaner,observeCleanup}=await import('../src/framework/cleaner.ts')
const {retirePublishedPhysicalRecovery}=await import('../src/framework/physical-recovery.ts')
const {DshAgentCreationCancelled}=await import('../src/adapters/dsh/host-types.ts')
const {gitCommandReceiptPath}=await import('../src/framework/command-transactions.ts')
const deps={gitCommandReceiptPath,DshAgentCreationCancelled,retireNativeSession,retirePublishedPhysicalRecovery,taskFamily,annotateFailure:e=>e,DshStorageAdapter,PhysicalLocalFiles,GitAuthorityStore,listAuthorityInRound,withSnapshot,withOperationChannel,paths,readJson,taskLifecycle,taskLifecycleKey,foregroundTaskSignal,readTaskReferenceIdentity,taskArchiveHostKey,taskArchiveHostFacts,readTaskArchiveState,parseDirectSignal,helperSignalWakeHash,isTerminalTask,encodeJson,hash}
const {openFrameworkConnection}=await import('../src/framework/connection.ts')
const {disposeResources}=await import('../src/framework/dispose-resources.ts')
const {omitAbsentFields}=await import('../src/adapters/dsh/json-record.ts')
const {z}=await import('zod')
const {createHash,randomUUID}=await import('node:crypto')
const {isDeepStrictEqual}=await import('node:util')
const {isAbsolute,resolve}=await import('node:path')
const {ExecutionControls}=await import('../src/framework/execution-control.ts')
const {NativeExecutions}=await import('../src/framework/native-executions.ts')
const names=['restoreCommandReceiptPaths','forgetAdmissionWake','localTaskRetirementRows','discoverRoles','roleRecordProblem','saveRole','saveRoleInChannel','assertOrganizerBusiness','roleKey','taskRuntimeReleased','taskSealAt','archiveHostKey','continueNativeRetirements','releaseTask','commitTaskSeal','cleanupWorkerTransfers','executionViews','requestExecutionStop','arrangeNativeContinuation','applyUserControls','serialWork','releaseLocalTask','retireTaskRuntime','taskReleaseWakes','withRoleWrite','deleteRuntimeRecord','watchKey','serialRecoveryWatch','restoreTaskOwner','retirePhysicalRestoreDebug','updateSafetyRestoreRow','dispose','disposeOwned','cancelledByShutdown','settleOperations']
const Runtime=new Function(...Object.keys(deps),'return class {\n'+names.map(method).join('\n')+'\n}')(...Object.values(deps))

const temp=await fs.mkdtemp(path.join(os.tmpdir(),'dss-control-final-release-')),checks=[],events=[]
const check=(name,value,expected)=>{assert.deepEqual(value,expected,name);checks.push({name,value})}
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
const tick=()=>new Promise(setImmediate),until=async f=>{for(let n=0;n<2000;n++){if(await f())return;await tick()}throw Error('Controlled boundary timed out')}
const nativeOpen=JsonStorageBackend.prototype.openUnit;let holdKey,entered,release,observeRoot
JsonStorageBackend.prototype.openUnit=async function(...args){const unit=await nativeOpen.apply(this,args);if(args[0].name==='record'){const put=unit.putRecord.bind(unit);unit.putRecord=async(t,k,v)=>{if(k.startsWith(observeRoot??'no-prefix'))events.push({event:'native-put',key:k});if(k===holdKey){entered.resolve();await release.promise}return put(t,k,v)}}return unit}
const sourceService=readFileSync(new URL('framework/service.ts',sourceRoot),'utf8'),serviceJs=stripTypeScriptTypes(sourceService,{mode:'transform'});loaded.set('framework/service.ts',hash(sourceService))
const extract=(js,name)=>{const m=new RegExp('\\n    (?:async )?'+name+'\\(').exec(js),start=m.index+1,next=/\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(js.slice(start+m[0].length));return next?js.slice(start,start+m[0].length+next.index):js.slice(start,js.lastIndexOf('\n}'))}
const settingsSchema=new Function('z',serviceJs.slice(serviceJs.indexOf('const model ='),serviceJs.indexOf('function abortedBy'))+';return settingsSchema')(z)
const abortedBy=(signal,error)=>!!signal?.aborted&&(error===signal.reason||(error instanceof Error&&error.name==='AbortError'&&error.cause===signal.reason))
const serviceDeps={withOperationChannel,z,settingsSchema,disposeResources,createHash,randomUUID,isDeepStrictEqual,isAbsolute,resolve,omitAbsentFields,abortedBy}
const Service=new Function(...Object.keys(serviceDeps),'return class {\n'+['stopExecution','checkScope','assertOpen','serialMode','participation','configure','config','persistSettings','stopRunning','stopManualCleanup','dispose','closeAccess'].map(n=>extract(serviceJs,n)).join('\n')+'\n}')(...Object.values(serviceDeps))
let serial=0
async function fixture(role){
 const dir=path.join(temp,String(++serial)),sdk=await openDshStorageFixture(path.join(dir,'records'),path.join(dir,'locator')),store=sdk.adapter,connection=await openFrameworkConnection({mode:'local',directory:path.join(dir,'local'),login:'A',workerSeats:0},{storage:store}),files=connection.files,scope=connection.scope,prefix='framework-runtime/'+hash(scope)+'/',root='framework-user-controls/'+hash(scope),taskId='60000000-0000-4000-8000-000000000001',instanceUUID='60000000-0000-4000-8000-000000000099';let clock=0
 const controls=new ExecutionControls(store,scope,()=>String(++clock),files,store,instanceUUID)
 const source='tasks/task_'+(role==='Organizer'?'O':'P')+'.md';await files.replace(source,'Existing completed Task');const task=await withSnapshot(files,s=>preparePhysicalTask(files,s,source,{taskId,owner:'A',members:['A']}));const terminal={...task,status:'complete'};await files.replace(paths.task(taskId),encodeJson(terminal));const history=taskHistoryChange(terminal);await files.replace(history.path,history.content)
 const observations=new ExecutionObservations(store,{arrange(){throw Error('No live observation')}},()=>{})
 const errors=[],nativeRetirements=[],journalEnter=defer(),journalRelease=defer();let holdJournal=false,journalFailure
 sdk.ctx.provide('nativeSessionCleaner',{retire:async id=>{nativeRetirements.push(id);if(holdJournal&&id==='final-native-session'){journalEnter.resolve();await journalRelease.promise}if(journalFailure&&id==='final-native-session')throw journalFailure}})
 const rt=Object.assign(new Runtime(),{ctx:sdk.ctx,files,records:store,prefix,controls,observations,config:{scope,mode:'local',member:'A',instanceUUID},localWakeAdmissions:new Map(),reportedAdmissionDiagnostics:new Set(),roleRecords:new Map(),roleBases:new Map(),roleWriteOwners:new Map(),wakeConsumptions:new Map(),cleanupResidues:new Map(),resolvedSafetyFaultIds:new Set(),retiredWorkers:new Map(),workOperations:new Map(),pendingControlStops:[],retryStartupControls(){},environment:{},error(e){if(!this.cancelledByShutdown(e))errors.push(String(e))},active:()=>false,wakeWrites:new Map(),wakeWriteOwners:new Map(),observationRecordWrites:new Map(),restoreWriteOwners:new Map(),safetyRestoreWrites:new Map()})
 const workId=rt.roleKey(role,taskId),old={identity:{role,taskId,...(role==='Planner'?{member:'A'}:{}),workId,executionId:'final-execution',lifecycleId:task.lifecycleId},sessionId:'final-native-session',generation:3,stopped:true}
 await rt.saveRole(old)
 const cleaner=new FrameworkCleaner(files,{}),host=new FrameworkHostLoop(files,{},store,{member:'A',primary:true,scope,instanceUUID},()=>['A'],{releaseTask:(...args)=>rt.releaseLocalTask(...args),clean:async(task,_snapshot,observation)=>(await cleaner.clean(task,observation)).status==='released',error:e=>rt.error(e)})
 // Fixture starts at the real Recorder notice's output, without claiming to run Recorder/model.
 await files.replace(paths.state('A',taskId)+'/Cleaner','')
 const observed=await withSnapshot(files,s=>observeCleanup(files,s,terminal,0))
 const key=taskLifecycleKey(terminal),cleanup={family:observed.family};host.record={initial:{},completed:{[key]:{cleanup}}};await host.save()
 const access={connection},settings={name:'Fixture',userName:'A',localDirectory:path.join(dir,'local'),ownerRepo:'',repositoryDirectory:'/',collaborationId:'fixture',workerSeats:0,workspace:'/fixture'}
 const service=Object.assign(new Service(),{storage:store,closed:false,access:async()=>access,moveError:()=>undefined,accessTransitions:new Map(),accesses:new Map(),accessOpening:new Map(),backgroundOpening:new Map(),configurationOwners:new Set(),modeConfiguration:new Map(),settingsCommands:new Map(),modeSending:new Map(),conversationBarriers:new Map(),configurationErrors:new Map(),reportedErrors:new Map(),archiveViews:new Map(),localUpgrades:new Map(),opening:new Map(),writePreparations:new Set(),relocationOwners:new Map(),listeners:new Set(),disposalErrors:[],saved:new Map([['local',{revision:'before',settings}]]),changed:()=>{},clearResolvedErrors:()=>{},settingsView:async()=>({mode:'local'}),cleanupFailure(_mode,error){this.disposalErrors.push(error)},stopping:new WeakMap(),gitUpgrades:new Map(),running:new Map([['local',{connection,runtime:rt}]])})
 const replacements=[]
 service.connect=async(mode,signal)=>{signal?.throwIfAborted();const next=await openFrameworkConnection({mode:'local',directory:settings.localDirectory,login:'A',workerSeats:0},{storage:store,signal});replacements.push(next);service.running.set(mode,{connection:next,runtime:{config:{workspace:service.config(mode).settings.workspace},dispose:async()=>{}}});return service.running.get(mode)}
 Object.assign(rt,{loop:host,cleaner,native:new NativeExecutions(sdk.ctx,{},observations),targetedPumps:new Map(),organizerWakeWrites:new Map()});rt.config.workspace='/fixture'

 const request=commandId=>service.stopExecution({mode:'local',storageScope:scope,commandId,workId,executionId:old.identity.executionId})
 return {dir,connection,replacements,settings,service,access,sdk,store,files,rt,controls,host,task:terminal,key,root,prefix,old,request,errors,nativeRetirements,holdJournal(failure){holdJournal=true;journalFailure=failure},journalEnter,journalRelease,close:async()=>{journalRelease.resolve();cleaner.close();for(const c of replacements)await c.close();await connection.close();await sdk.close()}}
}
try {
 for(const entry of ['participation','configure','plugin-dispose'])for(const hasRestore of [false,true])for(const failureMode of [false,true]) {
  const label=[entry,hasRestore?'completed-restore':'no-restore',failureMode?'journal-failed':'journal-accepted'].join('/'),f=await fixture('Planner');let coldSdk,coldFiles
  try {
   const restoreKey=f.prefix+'restores/'+hash('completed-prior-restore')
   if(hasRestore){
    // Explicit original restore input; the actual update writes its durable
    // completion and invokes physical debug retirement before Task cleanup.
    await f.store.set(restoreKey,{commandId:'completed-prior-restore',createdAt:'2026-11-09T00:00:00Z',input:{target:f.old.identity}})
    await f.rt.updateSafetyRestoreRow(restoreKey,'completed-prior-restore',current=>({...current,complete:true}))
    check(label+' real completion writer leaves completed original row before final release',(await f.store.get(restoreKey))?.complete,true)
   }
   const journalFailure=failureMode?new Error('Original exact native journal acceptance failed'):undefined
   f.holdJournal(journalFailure)
   const cleaning=f.host.continuePhysicalCleanup(f.key)
   await f.journalEnter.promise;await cleaning
   const cleanupBefore=await f.store.get(f.host.key),roleBefore=await f.store.get(f.prefix+'roles/'+hash(f.old.identity.workId))
   check(label+' already accepted cleanup stores exact family',cleanupBefore.completed[f.key].cleanup.family[0].taskId,f.task.taskId)
   check(label+' final release preserves stopped exact session',[roleBefore.stopped,roleBefore.released,roleBefore.sessionId],[true,true,f.old.sessionId])
   check(label+' physical metadata remains while native release is held',await withSnapshot(f.files,s=>readJson(f.files,s,paths.task(f.task.taskId))),f.task)
   const resource=f.host.physicalReleaseOperations.get(f.key),resourceResult=Promise.allSettled([resource])
   let storeCloses=0,transportClosed=false;const closeStore=f.store.close.bind(f.store)
   f.store.close=()=>{storeCloses++;return closeStore()}
   if(entry==='participation')await f.service.participation({mode:'local',enabled:false})
   // Workspace-only selection now stays hot; preset change still owns this shutdown.
   if(entry==='configure')await f.service.configure({mode:'local',commandId:'change-workspace',changedFields:['workspace','presetId'],settings:{...f.settings,workspace:'/different',presetId:'replacement-preset'}})
   if(entry==='plugin-dispose')await disposeResources([()=>{transportClosed=true},()=>f.service.dispose(),()=>f.store.close()])
   check(label+' actual public shutdown returns while journal is still held',f.host.physicalReleaseOperations.has(f.key),true)
   check(label+' actual original runtime is disposed',f.rt.closed,true)
   check(label+' original PhysicalLocalFiles is closed',f.files.closed,true)
   check(label+' actual connection records are plugin shared adapter',f.connection.records===f.store,true)
   check(label+' record adapter closes only at plugin lifetime',storeCloses,entry==='plugin-dispose'?1:0)
   const storeClosesAtEntryReturn=storeCloses
   if(entry==='configure'){
    check(label+' actual configure persisted new workspace',(await f.store.get('framework-settings/local')).settings.workspace,'/different')
    check(label+' actual configure persisted nonhot preset',(await f.store.get('framework-settings/local')).settings.presetId,'replacement-preset')
    check(label+' replacement registered connection opened before old journal resolved',f.replacements.length,1)
    check(label+' replacement owns different physical file handle',f.replacements[0].files!==f.files,true)
   }
   if(entry==='plugin-dispose')check(label+' transport closure step ran before storage closure',transportClosed,true)
   f.journalRelease.resolve()
   const [outcome]=await resourceResult;await tick()
   const succeeds=!revised&&!failureMode&&!hasRestore&&entry!=='plugin-dispose'
   check(label+' original retirement outcome',outcome.status,succeeds?'fulfilled':'rejected')
   if(failureMode){check(label+' exact original journal failure is preserved',outcome.reason,journalFailure);check(label+' original failure is reported',f.errors,[String(journalFailure)])}
   else if(revised){check(label+' closed guard preserves exact original shutdown reason',outcome.reason===f.rt.shutdownReason,true);check(label+' exact cancellation is not a new error',f.errors,[])}
   else if(!succeeds){
    const message=entry==='plugin-dispose'?'Record storage is closed':'Physical Local storage is closed'
    check(label+' without guard accesses actual closed owner',String(outcome.reason).includes(message),true)
    check(label+' closed-owner error reported',f.errors.some(x=>x.includes(message)),true)
   }
   // Reopen the exact same records and physical directory. No new Task or
   // metadata is created; original Host cleanup selects its original family.
   for(const c of f.replacements)await c.close();await f.connection.close();await f.sdk.close()
   coldSdk=await openDshStorageFixture(path.join(f.dir,'records'),path.join(f.dir,'locator'))
   coldFiles=new PhysicalLocalFiles(path.join(f.dir,'local'))
   const store=coldSdk.adapter,config=f.rt.config,retired=[]
   coldSdk.ctx.provide('nativeSessionCleaner',{retire:async id=>retired.push(id)})
   const observations=new ExecutionObservations(store,{arrange(){throw Error('No live observation')}},()=>{})
   const controls=new ExecutionControls(store,config.scope,undefined,coldFiles,store,config.instanceUUID)
   const rt=Object.assign(new Runtime(),{...f.rt,ctx:coldSdk.ctx,files:coldFiles,records:store,controls,observations,closed:false,disposing:undefined,localWakeAdmissions:new Map(),reportedAdmissionDiagnostics:new Set(),roleRecords:new Map(),roleBases:new Map(),roleWrites:new Map(),roleWriteOwners:new Map(),wakeConsumptions:new Map(),wakeWrites:new Map(),wakeWriteOwners:new Map(),workOperations:new Map(),pendingControlStops:[],resolvedSafetyFaultIds:new Set(),retiredWorkers:new Map(),cleanupResidues:new Map(),safetyRestoreWrites:new Map(),restoreWriteOwners:new Map()})
   for(const row of await rt.discoverRoles('roles/')){rt.roleBases.set(row.value.identity.workId,structuredClone(row.value));if(!row.value.released)rt.roleRecords.set(row.value.identity.workId,row.value)}
   const retainedRole=await store.get(f.prefix+'roles/'+hash(f.old.identity.workId))
   check(label+' cold role reflects actual completed or retained journal boundary',!!retainedRole,revised||failureMode||entry==='plugin-dispose')
   const cleaner=new FrameworkCleaner(coldFiles,{}),errors=[]
   const host=new FrameworkHostLoop(coldFiles,{},store,{member:'A',primary:true,scope:config.scope,instanceUUID:config.instanceUUID},()=>['A'],{observe:async()=>{},executing:()=>false,wake:async()=>false,releaseTask:(...args)=>rt.releaseLocalTask(...args),clean:async(task,_snapshot,observation)=>(await cleaner.clean(task,observation)).status==='released',error:e=>errors.push(String(e))})
   host.record=await store.get(host.key)
   check(label+' prior cleanup remains unless every actual technical step completed',!!host.record.completed[f.key]?.cleanup,!succeeds)
   check(label+' historical result retained',(await withSnapshot(coldFiles,s=>readTaskHistoryIdentity(coldFiles,s,f.task.taskId))).taskId,f.task.taskId)
   check(label+' metadata remains until cold continuation',await withSnapshot(coldFiles,s=>readJson(coldFiles,s,paths.task(f.task.taskId))),f.task)
   await host.poll();await Promise.all(host.physicalReleaseOperations.values());await until(async()=>!(await store.get(host.key)).completed[f.key]?.cleanup)
   check(label+' cold original responsibility retires exact remaining session',retired,retainedRole?[f.old.sessionId]:[])
   check(label+' exact original role is retired',await store.get(f.prefix+'roles/'+hash(f.old.identity.workId)),undefined)
   check(label+' exact cleanup is finished',(await store.get(host.key)).completed[f.key]?.cleanup,undefined)
   if(hasRestore)check(label+' completed original restore retires',await store.get(restoreKey),undefined)
   await host.poll();check(label+' repeated poll does not duplicate journal retirement',retired,retainedRole?[f.old.sessionId]:[])
   check(label+' cold continuation has no hidden error',errors,[])
   await host.stop();cleaner.close()
   events.push({label,guard:revised,oldResourceOutcome:outcome.status,error:outcome.reason?.message,storeClosesAtEntryReturn,storeClosesAfterTestCleanup:storeCloses,retainedRole:!!retainedRole})
  }finally{if(coldFiles)await coldFiles.close();if(coldSdk)await coldSdk.close();await f.close()}
 }
 console.log(JSON.stringify({status:revised?'verified-v76-real-close-entries':'verified-without-v75-guard',assertions:checks.length,checks,events,...evidence(),limits:'Actual public Service.participation(false), configure(nonhot preset plus workspace change), dispose; actual serialMode/stopRunning/persistSettings, registered openFrameworkConnection and InstanceRegistration.disconnect, real Local PhysicalLocalFiles and shared DSH SDK storage. Plugin host disposal order executes actual disposeResources, service.dispose, storage.close with a declared transport closure notification port; full RPC transport/model acquisition are not run. Configure replacement opens a second actual registered connection, with no native Runtime startup; view/notification/error-presentation ports are outside this test. Runtime methods are extracted unchanged. Original terminal Task/history/stopped role/Recorder signal and restore input are explicit fixture data; restore durable completion uses actual updateSafetyRestoreRow. Native journal acceptance is held or failed at the exact original session. Cold actual SDK reopening, discoverRoles, Host.poll continue only persisted original responsibility, not a new Task. Actual loaded source hashes are recorded; the inherited guard-status label is not a claim about the current complete product version. Not Windows, full DSH or real Git acceptance.'},null,2))
}finally{holdKey=undefined;release?.resolve();JsonStorageBackend.prototype.openUnit=nativeOpen;supplemental.deregister();hooks.deregister();await fs.rm(temp,{recursive:true,force:true})}
