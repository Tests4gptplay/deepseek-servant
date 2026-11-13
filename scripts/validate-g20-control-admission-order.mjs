import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
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
const {PhysicalLocalFiles,LocalTaskRecordParentMissing}=await import('../src/framework/physical-local-files.ts')
const {GitAuthorityStore,listAuthorityInRound}=await import('../src/framework/git-authority.ts')
const {withSnapshot,withOperationChannel}=await import('../src/framework/transactions.ts')
const {preparePhysicalTask,paths,readJson,taskLifecycle,taskLifecycleKey,foregroundTaskSignal,isTerminalTask,encodeJson,readMemberStatus,assertTaskLifecycle}=await import('../src/framework/task-files.ts')
const {readTaskHistoryIdentity,readTaskReferenceIdentity}=await import('../src/framework/task-history.ts')
const {taskArchiveHostKey,taskArchiveHostFacts,readTaskArchiveState}=await import('../src/framework/task-archive.ts')
const {parseDirectSignal}=await import('../src/framework/role-tools.ts')
const {helperSignalWakeHash,FrameworkHostLoop}=await import('../src/framework/host-loop.ts')
const {scanMemberRecovery,memberRecoveryEligible}=await import('../src/framework/recovery.ts')
const {DshSessionReader}=await import('../src/adapters/dsh/sessions.ts')
const runtimeSource=readFileSync(new URL('framework/role-runtime.ts',sourceRoot),'utf8');loaded.set('framework/role-runtime.ts',hash(runtimeSource))
const js=stripTypeScriptTypes(runtimeSource,{mode:'transform'})
const method=name=>{const m=new RegExp('\\n    (?:async )?'+name+'\\(').exec(js);assert(m,name);const start=m.index+1,next=/\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(js.slice(start+m[0].length));assert(next,name);return js.slice(start,start+m[0].length+next.index)}
const {readTaskCleanupRecord}=await import('../src/framework/cleaner.ts')
const {SessionId}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href)
const {publishPhysicalRecovery}=await import('../src/framework/physical-recovery.ts')
const {linkedChild}=await import('../src/framework/task-relations.ts')
const {effectiveTaskStates,unreadTaskMetadata}=await import('../src/framework/execution-control.ts')
const deps={linkedChild,effectiveTaskStates,unreadTaskMetadata,publishPhysicalRecovery,SessionId,readTaskCleanupRecord,DshAgentCreationCancelled:class extends Error{},scanMemberRecovery,memberRecoveryEligible,DshSessionReader,randomUUID,readMemberStatus,assertTaskLifecycle,readTaskHistoryIdentity,DshStorageAdapter,PhysicalLocalFiles,LocalTaskRecordParentMissing,GitAuthorityStore,listAuthorityInRound,withSnapshot,withOperationChannel,paths,readJson,taskLifecycle,taskLifecycleKey,foregroundTaskSignal,readTaskReferenceIdentity,taskArchiveHostKey,taskArchiveHostFacts,readTaskArchiveState,parseDirectSignal,helperSignalWakeHash,isTerminalTask,encodeJson,hash}
const {ExecutionControls}=await import('../src/framework/execution-control.ts')
const names=['applyAdmissionControl','admissionControlRelation','admissionTask','admissionParent','rememberAdmissionAncestry','taskCancellationPublished','rememberAdmissionWake','forgetAdmissionWake','holdAdmissionOwnership','clearLocalAdmissionInterval','persistLocalAdmission','localAdmissionRecord','taskControlPublished','startMaintenance','saveRole','saveRoleInChannel','assertOrganizerBusiness','roleKey','taskRuntimeReleased','taskSealAt','archiveHostKey','continueNativeRetirements','releaseTask','commitTaskSeal','cleanupWorkerTransfers','executionViews','requestExecutionStop','arrangeNativeContinuation','startupRecovery','currentTask','memberContinuationEligible','beforeTaskUse','requestKey','scanMembers','active','wake','storeWake','updateWake','admissionWakes','runQueue','runQueueInChannel','serialWork','settleOperations','stopOwnedRecord','confirmAdoptedWakes','publishPhysicalMemberRecovery','physicalSignalSources']
const Runtime=new Function(...Object.keys(deps),'return class {\n'+names.map(method).join('\n')+'\n}')(...Object.values(deps))


const {taskHistoryChange}=await import('../src/framework/task-history.ts')
const {publishTaskResume}=await import('../src/framework/task-resume.ts')
const {TaskWorkspaces}=await import('../src/framework/task-workspace.ts')
const {submitTaskCancellation}=await import('../src/framework/task-cancellation.ts')
const {physicalControlSignalSources}=await import('../src/framework/physical-control-signal-sources.ts')
const {z}=require('zod')
const serviceSource=readFileSync(new URL('framework/service.ts',sourceRoot),'utf8');loaded.set('framework/service.ts',hash(serviceSource));const sj=stripTypeScriptTypes(serviceSource,{mode:'transform'})
const sm=name=>{const m=new RegExp('\\n    (?:async )?'+name+'\\(').exec(sj);const start=m.index+1,next=/\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(sj.slice(start+m[0].length));return sj.slice(start,start+m[0].length+next.index)}
const Service=new Function('ExecutionControls','PhysicalLocalFiles','withOperationChannel','withSnapshot','readTaskCleanupRecord','readJson','paths','taskLifecycle','publishTaskResume','submitTaskCancellation','physicalControlSignalSources','z','return class {\n'+['controls','taskControl','stopExecution','checkScope'].map(sm).join('\n')+'\n}')(ExecutionControls,PhysicalLocalFiles,withOperationChannel,withSnapshot,readTaskCleanupRecord,readJson,paths,taskLifecycle,publishTaskResume,submitTaskCancellation,physicalControlSignalSources,z)
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'dss-g20-read-order-')),checks=[],details=[],resources=[]
const check=(name,value,expected)=>{assert.deepEqual(value,expected,name);checks.push({name,value})}
const gate=()=>{let enter,release;return{arrival:new Promise(r=>enter=r),wait:new Promise(r=>release=r),entered:()=>enter(),release:()=>release()}}
const tick=()=>new Promise(setImmediate),until=async f=>{const deadline=performance.now()+5000;for(;;){if(f())return;if(performance.now()>=deadline)throw Error('Probe boundary timeout');await new Promise(resolve=>setTimeout(resolve,1))}}
try {
 for (const sample of [{role:'Planner'},{role:'Organizer'},{role:'Planner',stopWorker:true}]) {
  const {role,stopWorker=false}=sample,label=role+(stopWorker?'-other-worker-stop':'-task-pause')
  const fixture=await openDshStorageFixture(path.join(temp,'sdk-'+label),path.join(temp,'locator-'+label)),store=fixture.adapter,files=new PhysicalLocalFiles(path.join(temp,'local-'+label));resources.push({fixture,files})
  const scope='read-order-'+label,taskId=randomUUID(),prefix='framework-runtime/'+hash(scope)+'/',controls=new ExecutionControls(store,scope,undefined,files,store,randomUUID())
  const source='tasks/original_'+(role==='Organizer'?'O':'P')+'.md';await files.replace(source,'Actual existing Task');const task=await withSnapshot(files,s=>preparePhysicalTask(files,s,source,{taskId,owner:'A',members:['A']}))
  const opens=[],sends=[],errors=[],instanceUUID=randomUUID(),workspaces=new TaskWorkspaces(files,path.join(temp,'native-'+label),'A',instanceUUID)
  await workspaces.ensure(taskId)
  const rt=Object.assign(new Runtime(),{ctx:fixture.ctx,files,records:store,prefix,controls,config:{scope,mode:'local',member:'A',instanceUUID,workerSeats:2},closed:false,
   knownTaskLifecycles:new Map(),localWakeAdmissions:new Map(),admissionObservationVersion:0,reportedAdmissionDiagnostics:new Set(),admissionNow:()=>Date.now(),roleRecords:new Map(),roleBases:new Map(),roleWriteOwners:new Map(),wakeConsumptions:new Map(),cleanupResidues:new Map(),resolvedSafetyFaultIds:new Set(),retiredWorkers:new Map(),wakeWrites:new Map(),wakeWriteOwners:new Map(),organizerWakeWrites:new Map(),admissionCancellations:new Map(),pendingControlStops:[],
   environment:{members:()=>['A'],resources:()=>[]},manuallyCleared:async()=>false,diagnoseMissingTask:async()=>false,physicalDirectInput:()=>undefined,rememberTerminalTask(){},retryStartupControls(){},replaySafetyWake(){},replaySafetyWakes(){},scheduleHelperSignal(){},startOwnedPump(){},waitingSafetyResolution:()=>false,transferredWorkerWake:()=>false,
   error:(error,context)=>errors.push({message:String(error),context}),workspaces,plannerWorkerExecutions:()=>[],binding:r=>r.identity,gateway:{exists:async()=>false},
   native:{get:()=>undefined,open:async(identity,options)=>{opens.push(identity);return{hasMessage:()=>false,send:async(...args)=>sends.push(args)}}}})
  rt.loop=new FrameworkHostLoop(files,{},store,{member:'A',primary:true,scope,instanceUUID},()=>['A'],{})
  const access={connection:{files,scope,sharedRecords:store,records:store,registration:{member:'A'},identity:{instanceUUID:rt.config.instanceUUID},transactions:{run(){throw Error('No physical transaction')}}}}
  const svc=Object.assign(new Service(),{access:async()=>access,running:new Map([['local',{connection:access.connection,runtime:rt}]]),withAccessOperation:async(i,f)=>f(access),beforeLocalTaskUse:async()=>true})
  const request={id:'original-admission-'+role,taskId,role,reason:'notification',sources:[]}
  await rt.wake(request)
  const worker={identity:{role:'Worker',taskId,member:'A',workerId:'worker-a',workId:rt.roleKey('Worker',taskId,'worker-a'),executionId:'worker-a-execution'},sessionId:'worker-a-session',generation:1,stopped:false};if(stopWorker)rt.roleRecords.set(worker.identity.workId,worker)
  const held=gate(),ownerKey='framework-user-controls/'+hash(scope)+(stopWorker?'/executions/'+hash(worker.identity.executionId):'/tasks/'+hash(taskId))
  let heldOnce=false
  const oldOpen=JsonStorageBackend.prototype.openUnit
  JsonStorageBackend.prototype.openUnit=async function(...args){const unit=await oldOpen.apply(this,args);if(args[0].name==='record'){const put=unit.putRecord.bind(unit);unit.putRecord=async(t,k,v)=>{if(k===ownerKey&&!heldOnce){heldOnce=true;held.entered();await held.wait}return put(t,k,v)}}return unit}
  if(files.updateInExistingDirectory){const update=files.updateInExistingDirectory.bind(files);files.updateInExistingDirectory=(p,decide,signal)=>update(p,async bytes=>{const result=await decide(bytes);if(p===controls.taskRecordPath(taskId)&&!heldOnce){heldOnce=true;held.entered();await held.wait}return result},signal)}
  let pauseDone=false;const pause=(stopWorker?svc.stopExecution({mode:'local',workId:worker.identity.workId,executionId:worker.identity.executionId,commandId:'original-worker-stop'}):svc.taskControl({mode:'local',taskId,intent:'paused',commandId:'original-pause-'+role})).finally(()=>pauseDone=true);await held.arrival
  let queueDone=false;const queue=rt.runQueue(false,request.id).finally(()=>queueDone=true)
  await new Promise(resolve=>setTimeout(resolve,500))
  const observed={pauseDone,queueDone,opens:opens.length,sends:sends.length,errors:structuredClone(errors)}
  check(label+' original command remains awaiting actual write',pauseDone,false)
  check(label+' admission waits only relevant original owner',[queueDone,opens.length,sends.length],stopWorker?[true,1,1]:[false,0,0])
  held.release();await pause;await queue;JsonStorageBackend.prototype.openUnit=oldOpen
  check(label+' admission outcome after original commit',[opens.length,sends.length],stopWorker?[1,1]:[0,0])
  details.push({role,stopWorker,beforeWriteReturned:observed,after:{opens:opens.length,sends:sends.length,control:(await controls.task(taskId))?.intent},errors})
  // A current owned execution can still be stopped when only metadata is lost.
  const identity={workId:rt.roleKey(role,taskId),executionId:'missing-metadata-'+role,role,taskId}
  rt.roleRecords.set(identity.workId,{identity,sessionId:'missing-session',generation:2,stopped:true})
  const retained=taskHistoryChange(task);await files.replace(retained.path,retained.content)
  await files.delete(paths.task(taskId))
  const result=await svc.stopExecution({mode:'local',workId:identity.workId,executionId:identity.executionId,commandId:'missing-metadata-stop'}).then(value=>({accepted:true,value}),error=>({accepted:false,error:String(error)}))
  details.push({role,missingMetadataStop:result,rootStillExists:!!await files.entryInfo(paths.run(taskId))})
  check(role+' current execution stop survives missing Task metadata',result.accepted,true)

 }
 console.log(JSON.stringify({checks,details,assertions:checks.length,...evidence(),limits:'Actual Service Task pause and Worker stop, real SDK or physical single-file update, actual wake/storeWake and runQueue/runQueueInChannel through native.open/send ports. No live model; setup callback and safety dispatch are controlled ports; TaskWorkspaces is real. Missing-metadata original current role is supplied and already confirmed stopped; this isolates command acceptance from native teardown.'},null,2))
} finally {for(const {fixture,files} of resources){await files.close();await fixture.close()}supplemental.deregister();hooks.deregister();await fs.rm(temp,{recursive:true,force:true})}
