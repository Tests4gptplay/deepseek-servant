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
const supplemental=registerHooks({resolve(s,c,next){if(s==='mdast-util-from-markdown')return{url:'data:text/javascript,export function fromMarkdown(text){if(text.includes("["))throw new Error("Markdown links outside this no-link fixture");return {type:"root",children:[]}}',shortCircuit:true};return next(s,c)},load(u,c,next){if(u===new URL('framework/skills.ts',sourceRoot).href)return{format:'module',source:'export const frameworkSkillIndexPath="skills/index.md";export function isFrameworkSkillDefinitionPath(){throw new Error("Skills outside wake test")};export function prepareFrameworkSkillIndex(){throw new Error("Skills outside wake test")}',shortCircuit:true};return next(u,c)}})
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
const deps={publishPhysicalRecovery,SessionId,readTaskCleanupRecord,DshAgentCreationCancelled:class extends Error{},scanMemberRecovery,memberRecoveryEligible,DshSessionReader,randomUUID,readMemberStatus,assertTaskLifecycle,readTaskHistoryIdentity,DshStorageAdapter,PhysicalLocalFiles,LocalTaskRecordParentMissing,GitAuthorityStore,listAuthorityInRound,withSnapshot,withOperationChannel,paths,readJson,taskLifecycle,taskLifecycleKey,foregroundTaskSignal,readTaskReferenceIdentity,taskArchiveHostKey,taskArchiveHostFacts,readTaskArchiveState,parseDirectSignal,helperSignalWakeHash,isTerminalTask,encodeJson,hash}
const {ExecutionControls}=await import('../src/framework/execution-control.ts')
const names=['saveRole','saveRoleInChannel','assertOrganizerBusiness','roleKey','taskRuntimeReleased','taskSealAt','archiveHostKey','continueNativeRetirements','releaseTask','commitTaskSeal','cleanupWorkerTransfers','executionViews','requestExecutionStop','arrangeNativeContinuation','startupRecovery','currentTask','memberContinuationEligible','beforeTaskUse','requestKey','scanMembers','active','wake','storeWake','updateWake','admissionWakes','runQueue','runQueueInChannel','serialWork','settleOperations','stopOwnedRecord','confirmAdoptedWakes','publishPhysicalMemberRecovery','physicalSignalSources','taskControlPublished','taskCancellationPublished']
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

const {installFrameworkRoleTools}=await import('../src/framework/role-tools.ts')

const taskFilesModule=await import('../src/framework/task-files.ts'),archiveModule=await import('../src/framework/task-archive.ts'),workspaceModule=await import('../src/framework/workspace-paths.ts')
const {reconstructPhysicalTask}=await import('../src/framework/physical-task-recovery.ts')
const {cancelPhysicalTask}=await import('../src/framework/physical-task-terminal.ts')
const {GitFiles}=await import('../src/framework/transactions.ts')
const recoveryDeps={...taskFilesModule,...archiveModule,...workspaceModule,hash,withOperationChannel,SessionId:id=>id,PhysicalLocalFiles,GitAuthorityStore,GitFiles,withSnapshot,reconstructPhysicalTask,isAbsolute:path.isAbsolute,join:path.join,resolve:path.resolve}
const Recovery=new Function(...Object.keys(recoveryDeps),'return class {\n'+['roleKey','recoverMissingTask','serialWork'].map(method).join('\n')+'\n}')(...Object.values(recoveryDeps))
async function restoreActual(f){
 const workspaces=new TaskWorkspaces(f.files,path.join(temp,'workspace-'+f.task.taskId),'A',f.instanceUUID),location=await workspaces.ensure(f.task.taskId)
 const retained=paths.member(f.task.taskId,'A')+'/Planner_Memory.md';await f.files.replace(retained,'Actual retained original work for in-place continuation.')
 const rt=new Recovery(),prefix='framework-runtime/'+hash(f.scope)+'/',identity={workId:rt.roleKey('Planner',f.task.taskId),executionId:'retained-planner',role:'Planner',taskId:f.task.taskId,member:'A'},record={identity,sessionId:'retained-session',generation:1,stopped:true,taskWorkspace:location},key=prefix+'roles/'+hash(identity.workId)
 await f.store.set(key,record)
 const row={key:prefix+'restores/'+hash('restore-while-pause-queued'),value:{commandId:'restore-while-pause-queued',createdAt:'2026-11-09T00:00:00Z',complete:false,input:{target:identity,taskRecovery:{route:'P',owner:'A',recordPaths:[retained],continuation:'Continue this actual cancelled original Task from its original material.'}}}}
 Object.assign(rt,{files:f.files,records:f.store,prefix,config:{member:'A',workspace:workspaces.root},workspaces,closed:false,roleRecords:new Map([[identity.workId,record]]),observedTerminalTasks:new Map(),knownTaskLifecycles:new Map(),currentTask:async r=>r.identity.taskId,environment:{},loop:{hasTerminalTask:()=>false},archiveHostKey:()=>archiveModule.taskArchiveHostKey(undefined,f.scope,f.instanceUUID),trackedStop:()=>true,
 ctx:{sessions:{get:()=>({header:{cwd:location.directory}})},get:()=>undefined},transactions:{run(){throw Error('No generic recovery transaction')}},
 rememberTerminalTask(){},updateSafetyRestoreRow:async(_key,_id,update)=>{Object.assign(row.value,update(row.value));return row.value},saveRole:async value=>{rt.roleRecords.set(value.identity.workId,value);await f.store.set(key,value)}})
 check('Actual recoverMissingTask accepts retained cancelled original Task',await rt.recoverMissingTask(row),true)
 return withSnapshot(f.files,s=>readJson(f.files,s,paths.task(f.task.taskId)))
}


const {FrameworkCleaner}=await import('../src/framework/cleaner.ts')
const SealRuntime=new Function(...Object.keys(recoveryDeps),'return class {\n'+['sealBusiness','withTaskFacts'].map(method).join('\n')+'\n}')(...Object.values(recoveryDeps))
async function completeAndCleanActual(f,beforeOriginalRelease=async()=>{}){
 const snapshot=await f.planner('dss_snapshot',{});await f.planner('dss_complete',{snapshotId:snapshot.snapshotId,acceptance:'Actual final completion before the original queued control could publish.',resultPaths:[]},'complete-for-original-control-cleanup')
 const terminal=await withSnapshot(f.files,s=>readJson(f.files,s,paths.task(f.task.taskId))),cleaner=new FrameworkCleaner(f.files,{}),wakes=[],errors=[]
 const sealing=Object.assign(new SealRuntime(),{files:f.files,archiveHostKey:()=>archiveModule.taskArchiveHostKey(undefined,f.scope,f.instanceUUID)})
 const host=new FrameworkHostLoop(f.files,{},f.store,{member:'A',primary:true,scope:f.scope,instanceUUID:f.instanceUUID},()=>['A'],{
  executing:()=>false,wake:async request=>{wakes.push(request);return true},sealBusiness:t=>sealing.sealBusiness(t.taskId,t.lifecycleId),cancelledBusinessStopped:async()=>{throw Error('Normal completion must not use cancellation gate')},
  releaseTask:async()=>{},clean:async(task,_view,observation)=>(await cleaner.clean(task,observation)).status==='released',error:e=>errors.push(String(e))})
 await withSnapshot(f.files,s=>host.scanTask(terminal,s,performance.now()));check('Actual Host admits Recorder before tool execution',wakes.map(r=>r.role),['Recorder'])
 const recorder=f.install({role:'Recorder',taskId:f.task.taskId,owner:'A',member:'A',workId:'recorder',executionId:'recorder-control-cleanup'})
 const view=await recorder('dss_snapshot',{});await recorder('dss_recorder_save',{snapshotId:view.snapshotId,outputs:[{path:view.archiveRecordsPath,text:'Actual final record before cleaning the original Task state.'}],retainedPaths:[]},'record-control-cleanup')
 // Cleaner is admitted immediately; the same Task directory queue still
 // orders a genuinely accepted control write before filesystem removal.
 const scan=withSnapshot(f.files,s=>host.scanTask(terminal,s,performance.now()))
 await beforeOriginalRelease()
 await scan
 await Promise.allSettled([...host.physicalReleaseOperations.values()])
 await host.continuePhysicalCleanup(taskLifecycleKey(terminal))
 check('Actual Cleaner removes run directory',await f.files.entryInfo(paths.run(f.task.taskId)),undefined)
 check('Actual Host removes Task metadata',await withSnapshot(f.files,s=>readJson(f.files,s,paths.task(f.task.taskId))),undefined)
 check('Original Recorder/Host/Cleaner path reports no failure',errors,[]);cleaner.close()
}

const temp=await fs.mkdtemp(path.join(os.tmpdir(),'dss-require-physical-audit-')),checks=[],samples=[],resources=[]
const check=(name,value,expected)=>{assert.deepEqual(value,expected,name);checks.push({name,value})}
const cleanupGates=[];const gate=()=>{let enter,release;const result={arrival:new Promise(r=>enter=r),wait:new Promise(r=>release=r),entered:()=>enter(),release:()=>release()};cleanupGates.push(result);return result}
const candidate=!!ExecutionControls.prototype.taskRecordPath,requiresMetadata=!!ExecutionControls.prototype.requirePhysicalTask,statusGate=readFileSync(new URL('framework/execution-control.ts',sourceRoot),'utf8').includes('A completed or cancelled Task cannot be paused or resumed.')
let serial=0
async function fixture(){
 const n=++serial,sdk=await openDshStorageFixture(path.join(temp,'sdk-'+n),path.join(temp,'locator-'+n)),files=new PhysicalLocalFiles(path.join(temp,'local-'+n)),store=sdk.adapter;resources.push({sdk,files})
 const scope='required-'+n,taskId=randomUUID(),source='tasks/request_P.md';await files.replace(source,'Real existing Task')
 const task=await withSnapshot(files,s=>preparePhysicalTask(files,s,source,{taskId,owner:'A',members:['A']})),instanceUUID=randomUUID(),controls=new ExecutionControls(store,scope,undefined,files,store,instanceUUID)
 const reads=[],read=files.records.readBytes.bind(files.records);let phase='setup',requires=0
 files.records.readBytes=async p=>{reads.push({phase,path:p});return read(p)}
 if(controls.requirePhysicalTask){const required=controls.requirePhysicalTask.bind(controls);controls.requirePhysicalTask=(...args)=>{requires++;return required(...args)}}
 const actualSet=controls.setTask.bind(controls);controls.setTask=async(...args)=>{phase='setTask';try{return await actualSet(...args)}finally{phase='after-setTask'}}
 // Service publishes the accepted Task control to its actual Runtime method.
 // This fixture has no queued wake admissions, so the production publication
 // has no admission to update; it must still be present at the real entry.
 const activeRuntime=Object.assign(new Runtime(),{controls,scheduleTaskResume(){},config:{primary:true,member:'A',collaborationId:'collab'},files,records:store,roleRecords:new Map(),stopOperations:new Map(),localWakeAdmissions:new Map(),transactions:{run(){throw Error('No generic Local transaction')}},archiveHostKey:()=>taskArchiveHostKey(undefined,scope,instanceUUID),physicalSignalSources:async()=>[]})
 const start=runtimeSource.indexOf('      taskControl: {',runtimeSource.indexOf('  private services()')),end=runtimeSource.indexOf('\n      cancelTask:',start),literal=stripTypeScriptTypes('const services={'+runtimeSource.slice(start,end)+'};',{mode:'transform'})
 const d={PhysicalLocalFiles,GitAuthorityStore,withSnapshot,readTaskCleanupRecord,readJson,paths,taskLifecycle,publishTaskResume}
 const taskControl=new Function(...Object.keys(d),literal+'return services.taskControl;').call(activeRuntime,...Object.values(d))
 const binding={role:'Foreground',owner:'A',member:'A',workId:'Foreground',executionId:'fg-execution',collaborationId:'collab',recordPath:'state/foreground/Foreground_Memory.md'}
 activeRuntime.roleRecords.set(binding.workId,{identity:{role:'Foreground',executionId:binding.executionId},sessionId:'fixture-session',generation:1})
 function install(b,tc){const ts=new Map(),agent={id:'agent-'+b.role,session:{}},ctx={on:()=>()=>{},effect:()=>{},systemPrompt:{section(){}},tools:{register:t=>ts.set(t.name,t)}};installFrameworkRoleTools(ctx,agent,b,{files,taskControl:tc,notifications:async()=>[],claimNotifications:async()=>({signals:[]}),transact:async()=>{throw Error('No generic Local transaction')},onError:e=>{throw e}});return async(name,input,id=name)=>{const t=ts.get(name);return t.execute(t.parameters?.parse?t.parameters.parse(input):input,{agent,callId:id,signal:new AbortController().signal,concludeTurn(){}})}}
 const foreground=install(binding,taskControl),planner=install({role:'Planner',taskId,owner:'A',member:'A',workId:'Planner',executionId:'planner-execution'})
 const conn={files,scope,sharedRecords:store,records:store,registration:{member:'A'},identity:{instanceUUID},transactions:activeRuntime.transactions}
 const access={connection:conn},svc=Object.assign(new Service(),{running:new Map([['local',{connection:conn,runtime:activeRuntime}]]),config:()=>({settings:{collaborationId:scope}}),withAccessOperation:async(i,f)=>f(access),beforeLocalTaskUse:async()=>true})
 const submit=(intent,commandId)=>{phase='service-upstream';return svc.taskControl({mode:'local',taskId,intent,commandId})}
 const reset=()=>{reads.length=0;requires=0;phase='tool'}
 const count=()=>({requires,taskMetadata:reads.filter(r=>r.path===paths.task(taskId)).length,archiveState:reads.filter(r=>r.path.endsWith('/state.json')).length,byPhase:Object.fromEntries([...new Set(reads.map(r=>r.phase))].map(p=>[p,{taskMetadata:reads.filter(r=>r.phase===p&&r.path===paths.task(taskId)).length,archiveState:reads.filter(r=>r.phase===p&&r.path.endsWith('/state.json')).length,all:reads.filter(r=>r.phase===p).length}])),reads:structuredClone(reads)})
 return {files,store,controls,task,submit,reset,count,foreground,planner,actualSet,scope,instanceUUID,service:svc,install}
}
try {
 check('G20 preserves original entry predicates without added fallback validation',requiresMetadata,false)
 check('G20 has no added queue-time terminal refusal',statusGate,false)
 for(const intent of ['paused','running']){
  const f=await fixture();f.reset();const result=await f.submit(intent,'ui-'+intent);const fresh=f.count();check('Service '+intent+' submits',result.submitted,true);check('Service '+intent+' require count',fresh.requires,requiresMetadata?1:0);check('Service '+intent+' setTask metadata count',fresh.byPhase.setTask.taskMetadata,candidate&&!requiresMetadata?0:1);check('Service '+intent+' setTask archive count',fresh.byPhase.setTask.archiveState,candidate?0:1);samples.push({entry:'Service',intent,fresh})
  f.reset();await f.submit(intent,'ui-'+intent);const replay=f.count();check('Service '+intent+' replay does not invoke require',replay.requires,0);check('Service '+intent+' replay setTask physical reads',replay.byPhase.setTask?.taskMetadata??0,0);samples.push({entry:'Service-replay',intent,replay})
 }
 for(const intent of ['paused','running']){
  const f=await fixture(),view=await f.foreground('dss_snapshot',{taskId:f.task.taskId});f.reset();const request={snapshotId:view.snapshotId,path:view.taskControlPath??f.controls.recordPath,append:false,text:JSON.stringify({taskId:f.task.taskId,intent})};const result=await f.foreground('dss_record',request,'fg-'+intent),counts=f.count();check('Foreground '+intent+' result',result.intent,intent);check('Foreground '+intent+' never invokes fallback require',counts.requires,0);check('Foreground '+intent+' setTask metadata count',counts.byPhase.setTask.taskMetadata,candidate?2:3);check('Foreground '+intent+' setTask archive count',counts.byPhase.setTask.archiveState,candidate?1:2);samples.push({entry:'registered-Foreground',intent,counts})
 }
 // The Service already read a running Task. Actual completion occurs before
 // that accepted command reaches the original writer. No manual status edit.
 {
  const f=await fixture(),held=gate();f.controls.setTask=async(...args)=>{held.entered();await held.wait;return f.actualSet(...args)}
  const pending=f.submit('paused','ui-before-completion').then(value=>({value}),error=>({error:String(error)}));await held.arrival
  const view=await f.planner('dss_snapshot',{});await f.planner('dss_complete',{snapshotId:view.snapshotId,acceptance:'Actual completion during the existing control write turn.',resultPaths:[]},'complete-during-control')
  const actual=await withSnapshot(f.files,s=>readJson(f.files,s,paths.task(f.task.taskId)));check('Actual registered completion changed Task',actual.status,'complete');held.release();const result=await pending
  check('Queued Service pause behavior differs at actual completion',!!result.error,statusGate);check('No Task business status is reopened',(await withSnapshot(f.files,s=>readJson(f.files,s,paths.task(f.task.taskId)))).status,'complete');samples.push({entry:'Service-pause-after-real-complete',result,controls:await f.controls.task(f.task.taskId)})
 }

 // Actual same-owner write tail: two Service calls have passed their original
 // upstream checks while the first real control publication is held.
 {
  const f=await fixture(),held=gate(),secondEntered=gate();let heldOnce=false
  if(candidate){const update=f.files.updateInExistingDirectory.bind(f.files);f.files.updateInExistingDirectory=(p,decide,signal,coordinateRemoval)=>update(p,async bytes=>{const value=await decide(bytes);if(p===f.controls.taskRecordPath(f.task.taskId)&&!heldOnce){heldOnce=true;held.entered();await held.wait}return value},signal,coordinateRemoval)}
  else{const set=f.store.set.bind(f.store);f.store.set=async(k,v)=>{if(k.includes('/tasks/')&&!heldOnce){heldOnce=true;held.entered();await held.wait}return set(k,v)}}
  const set=f.controls.setTask.bind(f.controls);f.controls.setTask=(command,...args)=>{if(command==='actual-queued-second')secondEntered.entered();return set(command,...args)}
  const first=f.submit('paused','actual-queued-first').then(value=>({value}),error=>({error:String(error)}));await held.arrival
  let secondDone=false;const second=f.submit('paused','actual-queued-second').then(value=>({value}),error=>({error:String(error)})).finally(()=>secondDone=true);await secondEntered.arrival
  check('Actual second Service command has reached original write tail',secondDone,false)
  const view=await f.planner('dss_snapshot',{});await f.planner('dss_complete',{snapshotId:view.snapshotId,acceptance:'Actual completion while original control file owner is still writing.',resultPaths:[]},'complete-during-actual-tail')
  held.release();const outcomes=[await first,await second]
  check('First original write retains accepted outcome after real completion',!!outcomes[0].value,true)
  check('Second original same-owner queued write hits new status predicate only',!!outcomes[1].error,statusGate)
  check('Neither original control changes completed business status',(await withSnapshot(f.files,s=>readJson(f.files,s,paths.task(f.task.taskId)))).status,'complete')
  samples.push({entry:'Service-real-original-owner-tail-completion',outcomes,control:await f.controls.task(f.task.taskId)})
 }

 {
  const f=await fixture(),held=gate(),secondEntered=gate();let heldOnce=false
  if(candidate){const update=f.files.updateInExistingDirectory.bind(f.files);f.files.updateInExistingDirectory=(p,decide,signal,coordinateRemoval)=>update(p,async bytes=>{const value=await decide(bytes);if(p===f.controls.taskRecordPath(f.task.taskId)&&!heldOnce){heldOnce=true;held.entered();await held.wait}return value},signal,coordinateRemoval)}
  else{const set=f.store.set.bind(f.store);f.store.set=async(k,v)=>{if(k.includes('/tasks/')&&!heldOnce){heldOnce=true;held.entered();await held.wait}return set(k,v)}}
  const set=f.controls.setTask.bind(f.controls);f.controls.setTask=(command,...args)=>{if(command==='old-life-queued-second')secondEntered.entered();return set(command,...args)}
  const first=f.submit('paused','old-life-first').then(value=>({value}),error=>({error:String(error)}));await held.arrival
  const second=f.submit('paused','old-life-queued-second').then(value=>({value}),error=>({error:String(error)}));await secondEntered.arrival
  await cancelPhysicalTask(f.files,{taskId:f.task.taskId},'A','actual-cancel-before-recovery');const restored=await restoreActual(f)
  check('Actual recovery keeps Task ID',restored.taskId,f.task.taskId);check('Actual recovery establishes new lifecycle',!!restored.lifecycleId,true);check('Actual recovery is running',restored.status,'running')
  held.release();const outcomes=[await first,await second]
  check('Original first accepted old-life write keeps original response',!!outcomes[0].value,true)
  check('Original second old-life response differs only by new metadata predicate',!!outcomes[1].error,requiresMetadata)
  const newControl=await f.controls.task(f.task.taskId,restored.lifecycleId),oldControl=await f.controls.task(f.task.taskId,'')
  check('Old-life pause does not pause reconstructed new lifecycle',newControl,undefined)
  check('Old-life control remains attached to original lifecycle',oldControl?.lifecycleId,undefined)
  samples.push({entry:'Service-original-owner-tail-actual-recovery',outcomes,oldControl,newControl:newControl??null,newLifecycle:restored.lifecycleId})
 }

 // Initial invalid selection remains an original Service rejection, not a new
 // lower-level gate. No arbitrary running-Task metadata removal is used.
 {
  const f=await fixture(),missing=randomUUID();let error
  try{await f.service.taskControl({mode:'local',taskId:missing,intent:'paused',commandId:'never-existed'})}catch(e){error=String(e)}
  check('Never-existing Task stays rejected by original Service',!!error&&error.includes('absent Task'),true)
  check('Never-existing selection creates no Task run root',await f.files.entryInfo(paths.run(missing)),undefined)
 }
 // Cancellation is produced by the same real Service button, not a hand edit.
 {
  const f=await fixture(),held=gate(),entered=gate();let once=false
  if(candidate){const update=f.files.updateInExistingDirectory.bind(f.files);f.files.updateInExistingDirectory=(p,decide,signal,coordinateRemoval)=>update(p,async bytes=>{const v=await decide(bytes);if(p===f.controls.taskRecordPath(f.task.taskId)&&!once){once=true;held.entered();await held.wait}return v},signal,coordinateRemoval)}
  else{const set=f.store.set.bind(f.store);f.store.set=async(k,v)=>{if(k.includes('/tasks/')&&!once){once=true;held.entered();await held.wait}return set(k,v)}}
  const set=f.controls.setTask.bind(f.controls);f.controls.setTask=(command,...args)=>{if(command==='pause-queued-at-cancel')entered.entered();return set(command,...args)}
  const first=f.submit('paused','pause-before-cancel').then(value=>({value}),error=>({error:String(error)}));await held.arrival
  const second=f.submit('paused','pause-queued-at-cancel').then(value=>({value}),error=>({error:String(error)}));await entered.arrival
  const cancel=await f.submit('cancelled','actual-user-cancel');check('Actual Service cancellation submits',cancel.submitted,true);held.release()
  const outcomes=[await first,await second];check('First original pause keeps its result through cancel',!!outcomes[0].value,true);check('Second original pause has original terminal semantics',!!outcomes[1].error,statusGate)
  check('Pause never reopens actual cancelled business Task',(await withSnapshot(f.files,s=>readJson(f.files,s,paths.task(f.task.taskId)))).status,'cancelled')
  samples.push({entry:'Service-pause-tail-actual-Service-cancel',outcomes})
 }
 {
  const f=await fixture(),held=gate(),entered=gate();let once=false
  if(candidate){const update=f.files.updateInExistingDirectory.bind(f.files);f.files.updateInExistingDirectory=(p,decide,signal,coordinateRemoval)=>update(p,async bytes=>{const v=await decide(bytes);if(p===f.controls.taskRecordPath(f.task.taskId)&&!once){once=true;held.entered();await held.wait}return v},signal,coordinateRemoval)}
  else{const set=f.store.set.bind(f.store);f.store.set=async(k,v)=>{if(k.includes('/tasks/')&&!once){once=true;held.entered();await held.wait}return set(k,v)}}
  const set=f.controls.setTask.bind(f.controls);f.controls.setTask=(command,...args)=>{if(command==='pause-queued-at-cleanup')entered.entered();return set(command,...args)}
  const first=f.submit('paused','pause-before-cleanup').then(value=>({value}),error=>({error:String(error)}));await held.arrival
  const second=f.submit('paused','pause-queued-at-cleanup').then(value=>({value}),error=>({error:String(error)}));await entered.arrival
  const requireCountBefore=f.count().requires;await completeAndCleanActual(f,async()=>{
   check('In-flight Task control write keeps its parent before same-Task Cleaner',Boolean(await f.files.entryInfo(paths.run(f.task.taskId))),true)
   held.release()
  });const outcomes=[await first,await second]
  check('Accepted queued original controls retain their own results before deletion',outcomes.map(result=>result.value?.submitted),[true,true])
  check('Queued controls add no new require callback',f.count().requires,requireCountBefore)
  check('Queued original controls cannot recreate deleted Task root',await f.files.entryInfo(paths.run(f.task.taskId)),undefined)
  const after=await f.submit('paused','after-final-delete').then(value=>({value}),error=>({error:String(error)}));check('After-delete new Service selection still uses original absent rejection',!!after.error&&after.error.includes('absent Task'),true)
  samples.push({entry:'Service-tail-actual-Recorder-Cleaner-removal',outcomes,after})
 }
 for(const through of ['Service','Foreground'])for(const failure of ['before-publish','after-publish']){
  const f=await fixture(),view=await f.foreground('dss_snapshot',{taskId:f.task.taskId}),cmd='original-'+failure;let once=false
  const call=intent=>through==='Service'?f.submit(intent,cmd):f.foreground('dss_record',{snapshotId:view.snapshotId,path:view.taskControlPath??f.controls.recordPath,append:false,text:JSON.stringify({taskId:f.task.taskId,intent})},cmd)
  let restore
  if(candidate){const update=f.files.updateInExistingDirectory.bind(f.files);restore=()=>f.files.updateInExistingDirectory=update;f.files.updateInExistingDirectory=async(p,...args)=>{if(p!==f.controls.taskRecordPath(f.task.taskId)||once)return update(p,...args);once=true;if(failure==='before-publish')throw Error('Original publication failed before write');const v=await update(p,...args);throw Error('UNKNOWN after original publication')}}
  else{const set=f.store.set.bind(f.store);restore=()=>f.store.set=set;f.store.set=async(k,v)=>{if(!k.includes('/tasks/')||once)return set(k,v);once=true;if(failure==='before-publish')throw Error('Original publication failed before write');await set(k,v);throw Error('UNKNOWN after original publication')}}
  const first=await call('paused').then(value=>({value}),error=>({error:String(error)}));restore();check(through+' '+failure+' original error retained',!!first.error,true)
  const retry=await call('paused');check(through+' '+failure+' same command retry retains original intended action',through==='Service'?retry.submitted:retry.intent,through==='Service'?true:'paused')
  const mismatch=await call('running').then(value=>({value}),error=>({error:String(error)}));check(through+' '+failure+' same command signature mismatch still rejected',!!mismatch.error&&mismatch.error.includes('different arguments'),true)
  samples.push({entry:through+'-'+failure+'-retry',first,retry,mismatch})
 }
 console.log(JSON.stringify({candidate,assertions:checks.length,checks,samples,...evidence(),limits:'Actual Service methods, registered Foreground dss_snapshot/dss_record, actual Planner completion and Service cancellation, real SDK/Zod/ExecutionControls/physical files. Real recoverMissingTask uses a confirmed-stopped retained RoleRecord, real TaskWorkspaces and physical reconstruction; native session lookup/save callback/discovery notification are explicit ports. Actual Host.scanTask admits Recorder, registered Recorder produces Cleaner and actual Host/Cleaner remove directories/metadata; releaseTask is an explicit no-op native-resource port, not proof of native retirement. No live model, whole Host timer drive or full typecheck/build. Body-read counts instrument LocalRecordFiles.readBytes, not all filesystem/SDK IO; setup and selected snapshot before submission are excluded. All gates hold original API operations; no production changes are made by this test.'},null,2))
}finally{for(const g of cleanupGates)g.release();for(const {sdk,files} of resources){await files.close();await sdk.close()}supplemental.deregister();hooks.deregister();await fs.rm(temp,{recursive:true,force:true})}
