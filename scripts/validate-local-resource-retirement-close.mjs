import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createRequire,registerHooks,stripTypeScriptTypes} from 'node:module'
import {pathToFileURL} from 'node:url'
import {sourceRoot,sdkHostRoot,hash,hooks,evidence,loaded} from './test-support/dsh-sdk-runtime.mjs'
import {openDshStorageFixture} from './test-support/dsh-sdk-storage.mjs'
const supplemental=registerHooks({resolve(s,c,next){if(s==='mdast-util-from-markdown')return{url:'data:text/javascript,export function fromMarkdown(){throw new Error("Markdown is outside this wake test")}',shortCircuit:true};return next(s,c)},load(u,c,next){if(u===new URL('framework/skills.ts',sourceRoot).href)return{format:'module',source:'export const frameworkSkillIndexPath="skills/index.md";export function isFrameworkSkillDefinitionPath(){throw new Error("Skills outside wake test")};export function prepareFrameworkSkillIndex(){throw new Error("Skills outside wake test")}',shortCircuit:true};return next(u,c)}})
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
const {localForegroundRoleRecordPath}=await import('../src/framework/conversation.ts')
const {taskFamily}=await import('../src/framework/task-relations.ts')
const {retireNativeSession}=await import('../src/adapters/dsh/native-cleaner.ts')
const {ExecutionObservations}=await import('../src/framework/execution-observation.ts')
const {FrameworkHostLoop}=await import('../src/framework/host-loop.ts')
const {FrameworkCleaner,observeCleanup}=await import('../src/framework/cleaner.ts')
const {retirePublishedPhysicalRecovery}=await import('../src/framework/physical-recovery.ts')
const {DshAgentCreationCancelled}=await import('../src/adapters/dsh/host-types.ts')
const deps={localForegroundRoleRecordPath,DshAgentCreationCancelled,retireNativeSession,retirePublishedPhysicalRecovery,taskFamily,annotateFailure:e=>e,DshStorageAdapter,PhysicalLocalFiles,GitAuthorityStore,listAuthorityInRound,withSnapshot,withOperationChannel,paths,readJson,taskLifecycle,taskLifecycleKey,foregroundTaskSignal,readTaskReferenceIdentity,taskArchiveHostKey,taskArchiveHostFacts,readTaskArchiveState,parseDirectSignal,helperSignalWakeHash,isTerminalTask,encodeJson,hash}
const {ExecutionControls}=await import('../src/framework/execution-control.ts')
const {NativeExecutions}=await import('../src/framework/native-executions.ts')
const names=['forgetAdmissionWake','localTaskRetirementRows','discoverRoles','roleRecordProblem','saveRole','saveRoleInChannel','assertOrganizerBusiness','roleKey','roleRecordPath','taskRuntimeReleased','taskSealAt','archiveHostKey','continueNativeRetirements','releaseTask','commitTaskSeal','cleanupWorkerTransfers','executionViews','requestExecutionStop','arrangeNativeContinuation','applyUserControls','serialWork','releaseLocalTask','retireTaskRuntime','taskReleaseWakes','withRoleWrite','deleteRuntimeRecord','watchKey','serialRecoveryWatch','restoreTaskOwner','retirePhysicalRestoreDebug','dispose','disposeOwned','cancelledByShutdown','settleOperations']
const Runtime=new Function(...Object.keys(deps),'return class {\n'+names.map(method).join('\n')+'\n}')(...Object.values(deps))

const temp=await fs.mkdtemp(path.join(os.tmpdir(),'dss-control-final-release-')),checks=[],events=[]
const check=(name,value,expected)=>{assert.deepEqual(value,expected,name);checks.push({name,value})}
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
const tick=()=>new Promise(setImmediate),until=async f=>{for(let n=0;n<2000;n++){if(await f())return;await tick()}throw Error('Controlled boundary timed out')}
const nativeOpen=JsonStorageBackend.prototype.openUnit;let holdKey,entered,release,observeRoot
JsonStorageBackend.prototype.openUnit=async function(...args){const unit=await nativeOpen.apply(this,args);if(args[0].name==='record'){const put=unit.putRecord.bind(unit);unit.putRecord=async(t,k,v)=>{if(k.startsWith(observeRoot??'no-prefix'))events.push({event:'native-put',key:k});if(k===holdKey){entered.resolve();await release.promise}return put(t,k,v)}}return unit}
const sourceService=readFileSync(new URL('framework/service.ts',sourceRoot),'utf8'),serviceJs=stripTypeScriptTypes(sourceService,{mode:'transform'});loaded.set('framework/service.ts',hash(sourceService))
const extract=(js,name)=>{const m=new RegExp('\\n    (?:async )?'+name+'\\(').exec(js),start=m.index+1,next=/\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(js.slice(start+m[0].length));return js.slice(start,start+m[0].length+next.index)}
const Service=new Function('withOperationChannel','return class {\n'+['stopExecution','checkScope','stopRunning','stopManualCleanup'].map(n=>extract(serviceJs,n)).join('\n')+'\n}')(withOperationChannel)
let serial=0
async function fixture(role){
 const dir=path.join(temp,String(++serial)),sdk=await openDshStorageFixture(path.join(dir,'records'),path.join(dir,'locator')),store=sdk.adapter,files=new PhysicalLocalFiles(path.join(dir,'local')),scope='final-release-'+serial,prefix='framework-runtime/'+hash(scope)+'/',root='framework-user-controls/'+hash(scope),taskId='60000000-0000-4000-8000-000000000001',instanceUUID='60000000-0000-4000-8000-000000000099';let clock=0
 const controls=new ExecutionControls(store,scope,()=>String(++clock),files,store,instanceUUID)
 const source='tasks/task_'+(role==='Organizer'?'O':'P')+'.md';await files.replace(source,'Existing completed Task');const task=await withSnapshot(files,s=>preparePhysicalTask(files,s,source,{taskId,owner:'A',members:['A']}));const terminal={...task,status:'complete'};await files.replace(paths.task(taskId),encodeJson(terminal));const history=taskHistoryChange(terminal);await files.replace(history.path,history.content)
 const observations=new ExecutionObservations(store,{arrange(){throw Error('No live observation')}},()=>{})
 const errors=[],nativeRetirements=[],journalEnter=defer(),journalRelease=defer();let holdJournal=false,journalFailure
 sdk.ctx.provide('nativeSessionCleaner',{retire:async id=>{nativeRetirements.push(id);if(holdJournal&&id==='final-native-session'){journalEnter.resolve();await journalRelease.promise}if(journalFailure&&id==='final-native-session')throw journalFailure}})
 const rt=Object.assign(new Runtime(),{ctx:sdk.ctx,files,records:store,prefix,controls,observations,config:{scope,collaborationId:scope,mode:'local',member:'A',instanceUUID},localWakeAdmissions:new Map(),reportedAdmissionDiagnostics:new Set(),roleRecords:new Map(),roleBases:new Map(),roleWriteOwners:new Map(),wakeConsumptions:new Map(),cleanupResidues:new Map(),resolvedSafetyFaultIds:new Set(),retiredWorkers:new Map(),workOperations:new Map(),pendingControlStops:[],retryStartupControls(){},environment:{},error(e){if(!this.cancelledByShutdown(e))errors.push(String(e))},active:()=>false,wakeWrites:new Map(),wakeWriteOwners:new Map(),observationRecordWrites:new Map(),restoreWriteOwners:new Map(),safetyRestoreWrites:new Map()})
 const workId=rt.roleKey(role,taskId),old={identity:{role,taskId,...(role==='Planner'?{member:'A'}:{}),workId,executionId:'final-execution',lifecycleId:task.lifecycleId},sessionId:'final-native-session',generation:3,stopped:true}
 await rt.saveRole(old)
 const cleaner=new FrameworkCleaner(files,{}),host=new FrameworkHostLoop(files,{},store,{member:'A',primary:true,scope,instanceUUID},()=>['A'],{releaseTask:(...args)=>rt.releaseLocalTask(...args),clean:async(task,_snapshot,observation)=>(await cleaner.clean(task,observation)).status==='released',error:e=>rt.error(e)})
 // Fixture starts at the real Recorder notice's output, without claiming to run Recorder/model.
 await files.replace(paths.state('A',taskId)+'/Cleaner','')
 const observed=await withSnapshot(files,s=>observeCleanup(files,s,terminal,0))
 const key=taskLifecycleKey(terminal),cleanup={family:observed.family};host.record={initial:{},completed:{[key]:{cleanup}}}
 const access={connection:{scope,files,close:async()=>{events.push({event:'connection-close'});await files.close();await store.close()}}},service=Object.assign(new Service(),{access:async()=>access,running:new Map([['local',{connection:access.connection,runtime:rt}]])})
 Object.assign(rt,{loop:host,cleaner,native:new NativeExecutions(sdk.ctx,{},observations),targetedPumps:new Map(),organizerWakeWrites:new Map()});Object.assign(service,{gitUpgrades:new Map(),stopping:new Map()})
 const request=commandId=>service.stopExecution({mode:'local',storageScope:scope,commandId,workId,executionId:old.identity.executionId})
 return {dir,service,access,sdk,store,files,rt,controls,host,task:terminal,key,root,prefix,old,request,errors,nativeRetirements,holdJournal(failure){holdJournal=true;journalFailure=failure},journalEnter,journalRelease,close:async()=>{journalRelease.resolve();cleaner.close();await files.close();await sdk.close()}}
}
try {
 for(const role of ['Planner','Organizer'])for(const failureMode of [false,true]) {
  const f=await fixture(role);let coldSdk,coldFiles
  try {
   const journalFailure=failureMode?new Error('Controlled original journal acceptance failure'):undefined
   f.holdJournal(journalFailure)
   const cleaning=f.host.continuePhysicalCleanup(f.key)
   await f.journalEnter.promise;await cleaning
   const peerId='60000000-0000-4000-8000-000000000002',peerSource='tasks/peer_P.md'
   await f.files.replace(peerSource,'Independent existing Task B')
   const peer=await withSnapshot(f.files,v=>preparePhysicalTask(f.files,v,peerSource,{taskId:peerId,owner:'A',members:['A']})),peerTerminal={...peer,status:'complete'}
   await f.files.replace(paths.task(peerId),encodeJson(peerTerminal));const peerHistory=taskHistoryChange(peerTerminal);await f.files.replace(peerHistory.path,peerHistory.content)
   const peerRole={identity:{role:'Planner',taskId:peerId,member:'A',workId:f.rt.roleKey('Planner',peerId),executionId:'peer-execution',lifecycleId:peer.lifecycleId},sessionId:'peer-native-session',generation:1,stopped:true}
   await f.rt.saveRole(peerRole);await f.files.replace(paths.state('A',peerId)+'/Cleaner','')
   const peerObserved=await withSnapshot(f.files,v=>observeCleanup(f.files,v,peerTerminal,0)),peerKey=taskLifecycleKey(peerTerminal)
   f.host.record.completed[peerKey]={cleanup:{family:peerObserved.family}}
   await f.host.continuePhysicalCleanup(peerKey)
   await Promise.all([...f.host.physicalReleaseOperations].filter(([key])=>key===peerKey).map(([,value])=>value));await tick()
   check(role+' same Host peer Task resource release does not await held A journal',f.host.physicalReleaseOperations.has(peerKey),false)
   check(role+' peer stopped role has actually retired',await f.store.get(f.prefix+'roles/'+hash(peerRole.identity.workId)),undefined)
   check(role+' peer Task metadata independently retired',await withSnapshot(f.files,v=>readJson(f.files,v,paths.task(peerId))),undefined)
   check(role+' peer exact native retirement completed once',f.nativeRetirements.filter(id=>id==='peer-native-session').length,1)
   check(role+' original A remains pending while peer ends',f.host.physicalReleaseOperations.has(f.key),true)
   const cleanupBefore=await f.store.get(f.host.key),roleBefore=await f.store.get(f.prefix+'roles/'+hash(f.old.identity.workId))
   check(role+' actual cleanup saved exact family after directory retirement',cleanupBefore.completed[f.key].cleanup.family[0].taskId,f.task.taskId)
   check(role+' role retains stopped/released exact session',[roleBefore.stopped,roleBefore.released,roleBefore.sessionId],[true,true,f.old.sessionId])
   const resource=f.host.physicalReleaseOperations.get(f.key),resourceResult=Promise.allSettled([resource])
   await f.service.stopRunning({runtime:f.rt,connection:f.access.connection})
   check(role+' actual Service.stopRunning closes owned record store while journal waits',f.store.closed,true)
   check(role+' accepted resource still pending after Service stop',f.host.physicalReleaseOperations.has(f.key),true)
   f.journalRelease.resolve()
   const [outcome]=await resourceResult;await tick()
   check(role+' late original continuation fails on closed records',outcome.status,'rejected')
   check(role+' late boundary result belongs to exact shutdown',outcome.reason===f.rt.shutdownReason,revised&&!failureMode)
   check(role+' late continuation does not attempt closed records',String(outcome.reason).includes('Record storage is closed'),!revised&&!failureMode)
   check(role+' shutdown cancellation is not reported as an independent fault',f.errors.some(x=>x.includes('Record storage is closed')),!revised&&!failureMode)
   if(revised&&!failureMode)check(role+' original Host filters only exact cancellation',f.errors,[])
   if(failureMode){check(role+' real independent journal failure is not replaced by cancellation',outcome.reason,journalFailure);check(role+' independent failure remains reported',f.errors,[String(journalFailure)])}
   await f.sdk.close()
   coldSdk=await openDshStorageFixture(path.join(f.dir,'records'),path.join(f.dir,'locator'))
   coldFiles=new PhysicalLocalFiles(path.join(f.dir,'local'))
   const store=coldSdk.adapter, config=f.rt.config, retired=[]
   coldSdk.ctx.provide('nativeSessionCleaner',{retire:async id=>retired.push(id)})
   const observations=new ExecutionObservations(store,{arrange(){throw Error('No live observation')}},()=>{})
   const controls=new ExecutionControls(store,config.scope,undefined,coldFiles,store,config.instanceUUID)
   const rt=Object.assign(new Runtime(),{...f.rt,ctx:coldSdk.ctx,files:coldFiles,records:store,controls,observations,closed:false,disposing:undefined,localWakeAdmissions:new Map(),reportedAdmissionDiagnostics:new Set(),roleRecords:new Map(),roleBases:new Map(),roleWrites:new Map(),roleWriteOwners:new Map(),wakeConsumptions:new Map(),wakeWrites:new Map(),wakeWriteOwners:new Map(),workOperations:new Map(),pendingControlStops:[],resolvedSafetyFaultIds:new Set(),retiredWorkers:new Map(),cleanupResidues:new Map()})
   // This is the actual startInChannel role restoration step, without starting
   // model recovery or claiming a whole native service bootstrap.
   for(const row of await rt.discoverRoles('roles/')){rt.roleBases.set(row.value.identity.workId,structuredClone(row.value));if(!row.value.released)rt.roleRecords.set(row.value.identity.workId,row.value)}
   check(role+' cold role discovery keeps released identity in original base only',[rt.roleRecords.size,rt.roleBases.get(f.old.identity.workId)?.sessionId],[0,f.old.sessionId])
   const cleaner=new FrameworkCleaner(coldFiles,{}),errors=[]
   const host=new FrameworkHostLoop(coldFiles,{},store,{member:'A',primary:true,scope:config.scope,instanceUUID:config.instanceUUID},()=>['A'],{observe:async()=>{},executing:()=>false,wake:async()=>false,releaseTask:(...args)=>rt.releaseLocalTask(...args),clean:async(task,_snapshot,observation)=>(await cleaner.clean(task,observation)).status==='released',error:e=>errors.push(String(e))})
   host.record=await store.get(host.key)
   rt.loop=host
   check(role+' cold Host restores persisted exact unfinished cleanup',host.record.completed[f.key].cleanup.family[0].taskId,f.task.taskId)
   check(role+' task metadata remains until native release completes',(await withSnapshot(coldFiles,s=>readJson(coldFiles,s,paths.task(f.task.taskId))))?.taskId,f.task.taskId)
   await host.poll()
   await Promise.all(host.physicalReleaseOperations.values());await tick()
   await Promise.all(host.physicalCleanupOperations.values());await tick()
   check(role+' actual Host poll resumes exact prior native retirement',retired,[f.old.sessionId])
   check(role+' cold continuation removes only original stopped role',await store.get(f.prefix+'roles/'+hash(f.old.identity.workId)),undefined)
   check(role+' cold Host retires original cleanup responsibility',(await store.get(host.key)).completed[f.key],undefined)
   check(role+' historical identity survives recovery',(await withSnapshot(coldFiles,s=>readTaskHistoryIdentity(coldFiles,s,f.task.taskId))).taskId,f.task.taskId)
   await host.poll();check(role+' repeated cold Host poll does not repeat retirement',retired,[f.old.sessionId])
   check(role+' peer historical identity remains untouched',(await withSnapshot(coldFiles,v=>readTaskHistoryIdentity(coldFiles,v,peerId))).taskId,peerId)
   check(role+' cold recovery has no hidden error',errors,[])
   await host.stop();cleaner.close()
  } finally {if(coldFiles)await coldFiles.close();if(coldSdk)await coldSdk.close();await f.close()}
 }
 console.log(JSON.stringify({status:revised?'passed-close-boundary-candidate':'reproduced-close-boundary-baseline',assertions:checks.length,checks,events,...evidence(),limits:'Actual Service.stopRunning, Runtime.dispose, Host.stop, physical Task resource retirement, Cleaner and SDK storage. Service connection.close is a declared port invoking actual PhysicalLocalFiles.close and DshStorageAdapter.close; InstanceRegistration.disconnect is not run. The native journal acceptance is a held confirming port; late original delete fails on the truly closed record adapter. Reopened actual SDK storage recovers persisted exact Host cleanup and released RoleRecord using actual discoverRoles; actual Host.poll continues that original release with original Task metadata retained until release. Cold role loading mirrors the exact startInChannel loop but does not run the full native/model bootstrap. Terminal Task, stopped role and Recorder notice are explicit inputs. Only the isolated runtime candidate may differ at the post-journal shutdown boundary. Test first runs against unchanged baseline. Existing cancelledByShutdown implementation supplies the error filter; the diagnostic reporting port records other errors. No Windows, complete Service connection shutdown or live-model acceptance claim.'},null,2))
} finally {holdKey=undefined;release?.resolve();JsonStorageBackend.prototype.openUnit=nativeOpen;supplemental.deregister();hooks.deregister();await fs.rm(temp,{recursive:true,force:true})}
