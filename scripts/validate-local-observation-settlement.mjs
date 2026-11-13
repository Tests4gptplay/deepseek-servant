import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createRequire,registerHooks,stripTypeScriptTypes} from 'node:module'
import {pathToFileURL} from 'node:url'
const selectedSource=process.env.DSS_SETTLEMENT_SOURCE_ROOT?pathToFileURL(path.resolve(process.env.DSS_SETTLEMENT_SOURCE_ROOT)+'/'):new URL('../',import.meta.url)
const beforeMode=process.env.DSS_SETTLEMENT_EXPECT_BEFORE==='1'
const {sourceRoot,sdkHostRoot,hash,hooks,evidence,loaded}=await import(new URL('scripts/test-support/dsh-sdk-runtime.mjs',selectedSource))
const {openDshStorageFixture}=await import(new URL('scripts/test-support/dsh-sdk-storage.mjs',selectedSource))
const supplemental=registerHooks({resolve(s,c,next){if(s==='mdast-util-from-markdown')return{url:'data:text/javascript,export function fromMarkdown(){throw new Error("Markdown is outside retirement scan test")}',shortCircuit:true};return next(s,c)}})
const require=createRequire(pathToFileURL(path.join(sdkHostRoot,'retirement-scan-audit.mjs')))
const {JsonStorageBackend}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-storage-json')).href)
const {DshAgentCreationCancelled,DshAgentAdmissionClosed}=await import(new URL('src/adapters/dsh/host-types.ts',selectedSource))
const {PhysicalLocalFiles}=await import(new URL('src/framework/physical-local-files.ts',selectedSource))
const {GitAuthorityStore,listAuthorityInRound}=await import(new URL('src/framework/git-authority.ts',selectedSource))
const {withSnapshot,withOperationChannel}=await import(new URL('src/framework/transactions.ts',selectedSource))
const {preparePhysicalTask,paths,readJson,taskLifecycle,taskLifecycleKey,isTerminalTask,encodeJson}=await import(new URL('src/framework/task-files.ts',selectedSource))
const {taskArchiveHostKey,taskArchiveHostFacts,readTaskArchiveState}=await import(new URL('src/framework/task-archive.ts',selectedSource))
const {retirePublishedPhysicalRecovery}=await import(new URL('src/framework/physical-recovery.ts',selectedSource))
const {ExecutionObservations}=await import(new URL('src/framework/execution-observation.ts',selectedSource))
const {ExecutionControls}=await import(new URL('src/framework/execution-control.ts',selectedSource))
const {FrameworkHostLoop}=await import(new URL('src/framework/host-loop.ts',selectedSource))
const {FrameworkTransactions,gitCommandReceiptPath}=await import(new URL('src/framework/command-transactions.ts',selectedSource))
const {FrameworkConversation}=await import(new URL('src/framework/conversation.ts',selectedSource))
const {taskFamily}=await import(new URL('src/framework/task-relations.ts',selectedSource))
const raw=readFileSync(new URL('framework/role-runtime.ts',sourceRoot),'utf8');loaded.set('framework/role-runtime.ts',hash(raw))
const js=stripTypeScriptTypes(raw,{mode:'transform'})
function method(name){const m=new RegExp('\\n    (?:async )?'+name+'\\(').exec(js);assert(m,name);const start=m.index+1,next=/\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(js.slice(start+m[0].length));return js.slice(start,next?start+m[0].length+next.index:js.lastIndexOf('\n}'))}
const { DshStorageAdapter } = await import(new URL('src/adapters/dsh/storage.ts',selectedSource))
const deps={gitCommandReceiptPath,DshStorageAdapter,DshAgentCreationCancelled,DshAgentAdmissionClosed,taskFamily,withOperationChannel,annotateFailure:e=>e,PhysicalLocalFiles,GitAuthorityStore,listAuthorityInRound,withSnapshot,paths,readJson,taskLifecycle,taskLifecycleKey,isTerminalTask,encodeJson,taskArchiveHostKey,taskArchiveHostFacts,readTaskArchiveState,retirePublishedPhysicalRecovery,hash}
const names=['localTaskRetirementRows','roleKey','archiveHostKey','taskSealAt','taskRuntimeReleased','deleteRuntimeRecord','forgetAdmissionWake','restoreTaskOwner','restoreCommandReceiptPaths','createSafetyRestoreRow','updateSafetyRestoreRow','retirePhysicalRestoreDebug','updateObservationRecord','releaseTask','releaseLocalTask','commitTaskSeal','cleanupWorkerTransfers','retireTaskRuntime','taskReleaseWakes','watchKey','serialRecoveryWatch','processRestores','replaySafetyRestore','processObservations','observe','applyUserControls','retryStartupControls','startTaskControlDiscovery','startMaintenance','startRestoration','restorePending','arrangeObservation','serialWork','trackedStop','saveRole','saveRoleInChannel','assertOrganizerBusiness','continueNativeRetirements','disposeOwned','cancelledByShutdown','settleOperations']
const Runtime=new Function(...Object.keys(deps),'return class {\n'+names.map(method).join('\n')+'\n}')(...Object.values(deps))
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'dss-retirement-scan-')),checks=[],costs=[],events=[]
const check=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);checks.push({name,actual})}
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
const tick=()=>new Promise(setImmediate)
const wait=async(f)=>{for(let n=0;n<500;n++){if(f())return;await tick()}throw Error('Timed out waiting for controlled boundary')}
let holdKey,entered,release
const originalOpen=JsonStorageBackend.prototype.openUnit
JsonStorageBackend.prototype.openUnit=async function(...args){const unit=await originalOpen.apply(this,args);if(args[0].name==='record'){const put=unit.putRecord.bind(unit);unit.putRecord=async(table,key,value)=>{if(key===holdKey){events.push({event:'native-put-held',key});entered.resolve();await release.promise}return put(table,key,value)}}return unit}
let serial=0
async function fixture(count){
 const dir=path.join(scratch,String(++serial)),sdk=await openDshStorageFixture(path.join(dir,'records'),path.join(dir,'locator')),store=sdk.adapter,files=new PhysicalLocalFiles(path.join(dir,'local')),scope='retirement-'+serial,prefix='framework-runtime/'+hash(scope)+'/',instanceUUID='50000000-0000-4000-8000-000000000099'
 const controls=new ExecutionControls(store,scope,undefined,files,store,instanceUUID)
 const unexpected=()=>{throw Error('No observation binding store operation is expected in this no-live-role retirement fixture')}
 const observations=new ExecutionObservations({get:unexpected,set:unexpected,list:unexpected,delete:unexpected},{arrange:unexpected},unexpected)
 const rt=Object.assign(new Runtime(),{files,records:store,prefix,controls,observations,startupControlsDiscovered:true,pendingControlStops:[],pendingTaskControlDiscovery:new Map(),config:{scope,mode:'local',member:'A',instanceUUID},admissionObservationVersion:0,localWakeAdmissions:new Map(),reportedAdmissionDiagnostics:new Set(),roleRecords:new Map(),roleBases:new Map(),retiredWorkers:new Map(),roleWriteOwners:new Map(),roleWrites:new Map(),wakeWriteOwners:new Map(),wakeWrites:new Map(),wakeConsumptions:new Map(),observationRecordWrites:new Map(),restoreWriteOwners:new Map(),safetyRestoreWrites:new Map(),cleanupResidues:new Map(),resolvedSafetyFaultIds:new Set(),environment:{},active:()=>false})
 const tasks=[],pending=[],restore=[]
 for(let n=1;n<=count;n++){
  const taskId='50000000-0000-4000-8000-'+String(n).padStart(12,'0'),source='tasks/retire'+n+'_P.md';await files.replace(source,'Existing completed Task retirement fixture '+n)
  const task=await withSnapshot(files,s=>preparePhysicalTask(files,s,source,{taskId,owner:'A',members:['A']}));const terminal={...task,status:'complete'};await files.replace(paths.task(taskId),encodeJson(terminal));tasks.push(terminal)
  const identity={role:'Planner',taskId,lifecycleId:task.lifecycleId,member:'A',workId:rt.roleKey('Planner',taskId),executionId:'existing-execution-'+n}
  const p={id:JSON.stringify([identity.workId,identity.executionId,1,1,1]),action:{identity,kind:'probe',stage:1,elapsedMs:5,silentMs:5},cycleStartedAt:1,checkedAt:6,progressAt:1};pending.push(p)
  await rt.updateObservationRecord(p);await rt.updateObservationRecord(p,{complete:true})
  const row={commandId:'existing-restore-'+n,createdAt:'2026-11-09T00:00:00.000Z',input:{target:identity,facts:'Existing execution restoration responsibility',hypotheses:'Completed prior intervention',actionsTaken:'Prior producer stopped',continuation:'Original Task'},complete:false};restore.push(row)
  const key=prefix+'restores/'+hash(row.commandId);await rt.createSafetyRestoreRow(key,row);await rt.updateSafetyRestoreRow(key,row.commandId,x=>({...x,complete:true,outcome:'terminal'}))
 }
 await tick()
 return {sdk,store,files,scope,prefix,rt,tasks,pending,restore,close:async()=>{await files.close();await sdk.close()}}
}
try{
 for(const lane of ['observations','restores']){
  const f=await fixture(2)
  let host,writing,poll
  try{
   for(let n=0;n<f.tasks.length;n++){f.tasks[n]={...f.tasks[n],status:'running'};await f.files.replace(paths.task(f.tasks[n].taskId),encodeJson(f.tasks[n]))}
   const tx=new FrameworkTransactions(f.files,f.store,f.scope),errors=[],arrangements=[],discoveries=[],initialized=[],wakes=[],scans=[]
   const noop=async()=>{}
   Object.assign(f.rt,{closed:false,workOperations:new Map(),environment:{heartbeat:noop},retryStartupTasks(){},processSealedBusiness:noop,startOwnedPump(){},processHostRestores:noop,error(e){errors.push(String(e))},arrangeObservation:async pending=>{arrangements.push({kind:'observation',id:pending.id,taskId:pending.action.identity.taskId});return false},processRestore:async row=>{arrangements.push({kind:'restore',id:row.value.commandId,taskId:row.value.input.target.taskId})}})
   host=new FrameworkHostLoop(f.files,tx,f.store,{member:'A',primary:true,scope:f.scope,instanceUUID:'50000000-0000-4000-8000-000000000099'},()=>['A'],{startup:noop,observeLocal:noop,observe:(round,observation)=>f.rt.observe(round,observation),initializeWorkspace:async task=>initialized.push(task.taskId),discoverTask:async task=>discoveries.push(task.taskId),executing:()=>false,wake:async request=>{wakes.push(request);return false},sealBusiness:noop,clean:async()=>false,releaseTask:noop,error(e){errors.push(String(e))}})
   await host.poll();while(f.rt.restoreScanning)await f.rt.restoreScanning
   await tick();discoveries.length=0;initialized.length=0;wakes.length=0
   const list=f.store.list.bind(f.store);f.store.list=async prefix=>{scans.push(prefix.slice(f.prefix.length));return list(prefix)}
   const a=f.tasks[0],b=f.tasks[1],aKey=f.prefix+lane+'/'+hash(lane==='observations'?f.pending[0].id:f.restore[0].commandId)
   holdKey=aKey;entered=defer();release=defer()
   writing=lane==='observations'?f.rt.updateObservationRecord(f.pending[0],{complete:true}):f.rt.updateSafetyRestoreRow(aKey,f.restore[0].commandId,x=>({...x,safetyAttempt:{failure:'Original accepted reporting write',terminal:false}}))
   await entered.promise
   let bKey
   if(lane==='observations'){
    const pending={...f.pending[1],id:'original-later-probe:'+f.pending[1].id,action:{...f.pending[1].action,stage:3},cycleStartedAt:2};bKey=f.prefix+'observations/'+hash(pending.id)
    await f.rt.updateObservationRecord(pending,{stopStarted:true})
   }else{
    const row={...f.restore[1],commandId:'original-later-restore',complete:false};bKey=f.prefix+'restores/'+hash(row.commandId);await f.rt.createSafetyRestoreRow(bKey,row)
   }
   check(lane+': newly accepted B responsibility exact read is independent',(await f.store.get(bKey))!==undefined,true)
   check(lane+': B original writer no longer owns an in-flight ID',lane==='observations'?!f.rt.observationRecordWrites.has(bKey):!f.rt.safetyRestoreWrites.has('original-later-restore'),true)
   await f.files.replace('tasks/new-independent_P.md','New independent user Task awaiting existing Host discovery')
   const conversation=new FrameworkConversation(f.files,tx,{mode:'local',collaborationId:'audit'});await conversation.send('original-foreground-message',{id:'original-foreground-message',participantId:'user',createdAt:'2026-11-09T00:00:00.000Z',role:'user',recipient:'ai',text:'Independent Foreground message'})
   let pollDone=false;poll=host.poll().then(()=>{pollDone=true})
   await wait(()=>scans.includes(lane+'/'));await new Promise(r=>setTimeout(r,30))
   check(lane+': pending A prevents B discovery into original delivery boundary',arrangements.some(x=>x.taskId===b.taskId),false)
   check(lane+': unrelated Foreground signal channel still reaches original wake boundary',wakes.some(x=>x.role==='Foreground'),true)
   if(lane==='observations'&&beforeMode){
    check('Observation settle prefix remains in awaited common Host poll',pollDone,false)
    check('Observation settle prefix prevents already-existing Task discovery',discoveries.length,0)
    check('Observation settle prefix prevents new source conversion',/Task ID:/.test(await withSnapshot(f.files,s=>f.files.read(s,'tasks/new-independent_P.md'))),false)
   }else{
    await poll
    check(lane+': discovery remains outside common Host poll',pollDone,true)
    check(lane+': prefix does not prevent existing B Task discovery',discoveries.includes(b.taskId),true)
    check(lane+': prefix does not prevent new source conversion',/Task ID:/.test(await withSnapshot(f.files,s=>f.files.read(s,'tasks/new-independent_P.md'))),true)
    check(lane+': original scan remains owned while native A write is pending',lane==='restores'?!!f.rt.restoreScanning:!!f.rt.maintenance?.has('observation-settlement-discovery'),true)
   }
   if(lane==='observations'&&!beforeMode){
    await host.poll()
    check('A second ordinary Host poll reuses the held discovery owner rather than starting another prefix read',scans.filter(p=>p==='observations/').length,1)
   }
   events.push({event:'release-original-A',lane});holdKey=undefined;release.resolve();await writing;await poll
   await wait(()=>arrangements.some(x=>x.taskId===b.taskId));while(f.rt.restoreScanning)await f.rt.restoreScanning
   check(lane+': original B responsibility reaches delivery boundary after A settles',arrangements.some(x=>x.taskId===b.taskId),true)
   check(lane+': new source is converted after ordinary Host observation is allowed',/Task ID:/.test(await withSnapshot(f.files,s=>f.files.read(s,'tasks/new-independent_P.md'))),true)
   check(lane+': no errors reported',errors,[])
   costs.push({lane,scans,discoveries,initialized,arrangements,pollFinishedWhileAWasHeld:lane==='restores'||!beforeMode})
  }finally{holdKey=undefined;release?.resolve();await writing;await poll;await host?.stop();f.rt.closed=true;while(f.rt.restoreScanning)await f.rt.restoreScanning;await Promise.allSettled([...f.rt.maintenance?.values()??[]]);await f.close()}
 }
 function configure(f){
  const errors=[],noop=async()=>{}
  Object.assign(f.rt,{closed:false,workOperations:new Map(),environment:{heartbeat:noop},retryStartupTasks(){},processSealedBusiness:noop,startOwnedPump(){},processHostRestores:noop,error(e){errors.push(String(e))},targetedPumps:new Map(),organizerWakeWrites:new Map(),cleaner:{close(){}},native:{cancelOpening(){throw Error('No native opening in this fixture')}}})
  return errors
 }
 async function drain(f){for(let n=0;n<100;n++){const all=[...f.rt.maintenance?.values()??[],...f.rt.observationOperations?.values()??[],...f.rt.restoreOperations?.values()??[],...(f.rt.restoreScanning?[f.rt.restoreScanning]:[])];if(!all.length){await tick();if(!f.rt.maintenance?.size&&!f.rt.observationOperations?.size&&!f.rt.restoreScanning)return}else await Promise.allSettled(all)}throw Error('Owned operations failed to settle')}
 function originalPending(f,name,stage=3){const base=f.pending[0];return {...base,id:JSON.stringify([base.action.identity.workId,base.action.identity.executionId,name,stage,1]),action:{...base.action,stage},cycleStartedAt:name}}
 async function putPending(f,name,stopStarted=true){const p=originalPending(f,name);await f.rt.updateObservationRecord(p,stopStarted?{stopStarted:true}:{});return {p,key:f.prefix+'observations/'+hash(p.id)}}
 {
  const f=await fixture(1)
  try{
   const errors=configure(f),pending=await putPending(f,'singleflight'),gate=defer(),calls=[]
   f.rt.arrangeObservation=async(p,lane)=>{calls.push({id:p.id,lane});await gate.promise}
   const list=f.store.list.bind(f.store);let scans=0;f.store.list=async prefix=>{if(prefix===f.prefix+'observations/')scans++;return list(prefix)}
   await f.rt.observe();await wait(()=>calls.length===1)
   const native=f.rt.processObservations(false,'native',false);await f.rt.observe();await native
   check('Native and settle observers share the same original per-record operation',calls.length,1)
   check('Shared original operation keeps exact pending ID',calls[0].id,pending.p.id)
   gate.resolve();await drain(f);await f.rt.observe();await drain(f)
   check('Completed original request is not redelivered by the next Host observation',calls.length,1)
   check('Completed original body is durably marked complete',(await f.store.get(pending.key)).complete,true)
   check('Singleflight has no error',errors,[])
  }finally{await f.close()}
 }
 {
  const f=await fixture(1)
  try{
   const errors=configure(f),pending=await putPending(f,'failed-list'),list=f.store.list.bind(f.store);let reject=true,calls=0
   f.rt.arrangeObservation=async()=>{calls++}
   f.store.list=async prefix=>{if(reject&&prefix===f.prefix+'observations/'){reject=false;throw Error('Controlled original discovery read failure')}return list(prefix)}
   await f.rt.observe();await drain(f)
   check('Discovery failure is reported once through the original error path',errors.length,1)
   check('Discovery failure does not mark an undiscovered action complete',(await f.store.get(pending.key)).complete,false)
   check('Failed discovery does not deliver',calls,0)
   await f.rt.observe();await drain(f)
   check('Next existing observation retries discovery and delivers original action',calls,1)
   check('Next observation completes the original persisted row',(await f.store.get(pending.key)).complete,true)
   check('Failed maintenance key is released',f.rt.maintenance.has('observation-settlement-discovery'),false)
  }finally{await f.close()}
 }
 for(const failure of ['explicit-before-put','accepted-then-unknown']){
  const f=await fixture(1)
  try{
   const errors=configure(f),pending=await putPending(f,failure,false),set=f.store.set.bind(f.store);let injected=false,calls=0
   f.rt.arrangeObservation=async()=>{calls++}
   f.store.set=async(k,v)=>{if(k===pending.key&&!injected){injected=true;if(failure==='explicit-before-put')throw Error('Explicit controlled owner write failure');await set(k,v);throw Error('Controlled UNKNOWN after accepted owner write')}return set(k,v)}
   await assert.rejects(f.rt.updateObservationRecord(pending.p,{stopStarted:true}));checks.push({name:failure+': original write error is preserved',actual:true})
   await f.rt.observe();await drain(f)
   check(failure+': only accepted original stopStarted responsibility is discoverable',calls,failure==='explicit-before-put'?0:1)
   if(failure==='explicit-before-put'){await f.rt.updateObservationRecord(pending.p,{stopStarted:true});await f.rt.observe();await drain(f)}
   check(failure+': same exact original row eventually completes',(await f.store.get(pending.key)).complete,true)
   await f.rt.observe();await drain(f)
   check(failure+': no extra delivery after completion',calls,1)
   check(failure+': scan itself did not turn write failure into a new error',errors,[])
  }finally{await f.close()}
 }
 {
  const f=await fixture(1);let writer,poll,closing
  try{
   const errors=configure(f),pending=await putPending(f,'shutdown'),tx=new FrameworkTransactions(f.files,f.store,f.scope);let calls=0,scanEntered=false
   f.rt.arrangeObservation=async()=>{calls++}
   f.rt.loop=new FrameworkHostLoop(f.files,tx,f.store,{member:'A',primary:true,scope:f.scope,instanceUUID:'50000000-0000-4000-8000-000000000099'},()=>['A'],{startup:async()=>{},observeLocal:async()=>{},observe:(r,o)=>f.rt.observe(r,o),executing:()=>false,wake:async()=>false,sealBusiness:async()=>{},clean:async()=>false,releaseTask:async()=>{},error:e=>errors.push(String(e))})
   const key=f.prefix+'observations/'+hash(f.pending[0].id),list=f.store.list.bind(f.store);f.store.list=async prefix=>{if(prefix===f.prefix+'observations/')scanEntered=true;return list(prefix)}
   holdKey=key;entered=defer();release=defer();writer=f.rt.updateObservationRecord(f.pending[0],{complete:true});await entered.promise
   poll=f.rt.loop.poll();await wait(()=>scanEntered)
   let closed=false;closing=f.rt.disposeOwned().then(()=>{closed=true});await tick()
   check('Real disposeOwned retains the accepted original discovery read',closed,false)
   holdKey=undefined;release.resolve();await writer;await poll;await closing
   check('Real disposeOwned finishes after original read settles',closed,true)
   check('Closing forbids late delivery of the still-pending original request',calls,0)
   check('Unperformed request remains durably pending after shutdown',(await f.store.get(pending.key)).complete,false)
   check('Original discovery owner is drained at shutdown',f.rt.maintenance.size,0)
   check('Shutdown reports no fabricated success or error',errors,[])
  }finally{holdKey=undefined;release?.resolve();await writer;await poll;await closing;await f.close()}
 }
 {
  const f=await fixture(1)
  try{
   const errors=configure(f),task={...f.tasks[0],status:'running'};await f.files.replace(paths.task(task.taskId),encodeJson(task))
   const identity=f.pending[0].action.identity,record={identity,sessionId:'controlled-native-session',generation:1};await f.rt.saveRole(record)
   const sent=[],restored=[],stopRequests=[],stopping=defer(),owned={sessionId:record.sessionId,send:async(_text,id)=>sent.push(id)}
   Object.assign(f.rt,{beforeTaskUse:async()=>true,observationTaskHeld:async()=>false,observations:{mayApply:async()=>true,deferUnperformed:async()=>{}},native:{get:()=>owned},ownedAsyncContext:fn=>fn(),safetyCommandFor:()=>undefined,publishPhysicalMemberRecovery:async()=>undefined,publishOwnerRecovery:async()=>{},arrangeNativeContinuation:async(r,_context,_inspection,id)=>{restored.push({executionId:r.identity.executionId,id})},stopOwnedRecord:async r=>{stopRequests.push(r.identity.executionId);return stopRequests.length===1?stopping.promise:{status:'stopped'}}})
   const probe=originalPending(f,'live-probe',1);await f.rt.updateObservationRecord(probe)
   await f.rt.processObservations(false,'settle',false);await drain(f)
   check('Settle lane never delivers an active stage1 probe',sent.length,0)
   await f.rt.processObservations(false,'native',false);await drain(f)
   check('Existing native lane delivers original active probe exactly once',sent,[probe.id])
   const pending=await putPending(f,'stage3',false)
   await f.rt.processObservations(false,'settle',false);await drain(f)
   check('Settle lane cannot start an unstarted native stop',stopRequests.length,0)
   await f.rt.processObservations(false,'native',false);await drain(f);await wait(()=>stopRequests.length===1)
   check('Native lane durably records original stopStarted',(await f.store.get(pending.key)).stopStarted,true)
   await f.rt.processObservations(false,'settle',false);await drain(f)
   check('Settle does not duplicate a pending native stop',stopRequests.length,1)
   check('No continuation before original producer confirms stop',restored,[])
   stopping.resolve({status:'unconfirmed',reason:'Controlled native stop UNKNOWN',jobs:['original-job']});await Promise.all([...f.rt.stopOperations.values()].map(v=>v.promise))
   await f.rt.processObservations(false,'settle',false);await drain(f)
   check('UNKNOWN is not turned into stopped or completed',[(f.rt.roleRecords.get(identity.workId)).stopped??false,(await f.store.get(pending.key)).complete],[false,false])
   check('UNKNOWN still does not restore',restored,[])
   await f.rt.processObservations(false,'native',false);await drain(f);await Promise.all([...f.rt.stopOperations.values()].map(v=>v.promise))
   check('Original native retry confirms the same execution',f.rt.roleRecords.get(identity.workId).stopped,true)
   await f.rt.processObservations(false,'settle',false);await drain(f)
   check('Confirmed-stop settlement restores original exact execution once',restored,[{executionId:identity.executionId,id:'observation-restart:'+pending.p.id}])
   await f.rt.processObservations(false,'native',false);await f.rt.processObservations(false,'settle',false);await drain(f)
   check('Next native/settle rounds do not duplicate restored action',restored.length,1)
   check('Original tracked stop reported UNKNOWN once',errors.filter(x=>x.includes('Controlled native stop UNKNOWN')).length,1)
   const obsolete=await putPending(f,'replaced',true);await f.rt.saveRole({...f.rt.roleRecords.get(identity.workId),identity:{...identity,executionId:'replacement-execution'},sessionId:'replacement-native',generation:2,stopped:true})
   await f.rt.processObservations(false,'settle',false);await drain(f)
   check('Old request is not redirected to the replacement execution',restored.length,1)
   check('Superseded original action settles its own row only',(await f.store.get(obsolete.key)).complete,true)
  }finally{await f.close()}
 }
 for(const failure of ['delivery-before-completion','completion-write-accepted-unknown']){
  const f=await fixture(1)
  try{
   const errors=configure(f),pending=await putPending(f,failure),attempts=[];let first=true
   f.rt.arrangeObservation=async p=>{attempts.push(p.id);if(failure==='delivery-before-completion'&&first){first=false;throw Error('Controlled original delivery failure')}}
   if(failure==='completion-write-accepted-unknown'){
    const set=f.store.set.bind(f.store);f.store.set=async(k,v)=>{await set(k,v);if(k===pending.key&&v.complete&&first){first=false;throw Error('Controlled UNKNOWN after original completion write')}}
   }
   await f.rt.observe();await drain(f)
   check(failure+': original failure is reported exactly once',errors.length,1)
   check(failure+': durable complete is not fabricated or undone',(await f.store.get(pending.key)).complete,failure==='completion-write-accepted-unknown')
   await f.rt.observe();await drain(f)
   check(failure+': retry count follows original durable state',attempts.length,failure==='completion-write-accepted-unknown'?1:2)
   check(failure+': all attempts retain original exact pending ID',attempts.every(id=>id===pending.p.id),true)
   check(failure+': original row reaches complete',(await f.store.get(pending.key)).complete,true)
  }finally{await f.close()}
 }
 {
  const f=await fixture(1)
  try{
   const errors=configure(f),attempts=[];f.rt.arrangeObservation=async p=>{attempts.push(p.id)}
   await f.rt.observe();await drain(f)
   const pending=await putPending(f,'created-after-prior-poll')
   check('A later original writer retains a durable request after its short-term owner finishes',f.rt.observationRecordWrites.has(pending.key),false)
   await f.rt.observe();await drain(f)
   check('The next existing Host observation discovers the later original request',attempts,[pending.p.id])
   check('Later original discovery reports no error',errors,[])
  }finally{await f.close()}
 }
 {
  const f=await fixture(1)
  try{
   const errors=configure(f),list=f.store.list.bind(f.store),captured=defer(),gate=defer(),attempts=[];let first=true
   f.rt.arrangeObservation=async p=>{attempts.push(p.id)}
   f.store.list=async prefix=>{const rows=await list(prefix);if(first&&prefix===f.prefix+'observations/'){first=false;captured.resolve();await gate.promise}return rows}
   let oldRoundDone=false;const oldRound=f.rt.observe().then(()=>{oldRoundDone=true});await captured.promise
   const pending=await putPending(f,'after-list-capture-before-owner-finish')
   check('Current discovery owner is still pending after rows were captured',beforeMode?!oldRoundDone:f.rt.maintenance.has('observation-settlement-discovery'),true)
   gate.resolve();await oldRound;await drain(f)
   check('A row created after list capture is not promised in the old discovery result',attempts,[])
   check('The later original row stays pending until a subsequent ordinary observation',(await f.store.get(pending.key)).complete,false)
   await f.rt.observe();await drain(f)
   check('Next ordinary observation finds the after-capture original request',attempts,[pending.p.id])
   check('After-capture discovery has no error',errors,[])
  }finally{await f.close()}
 }
 {
  const f=await fixture(1)
  try{
   const errors=configure(f),pending=await putPending(f,'retired-after-list-capture'),list=f.store.list.bind(f.store),captured=defer(),gate=defer();let first=true,continuations=0
   f.rt.beforeTaskUse=async()=>true;f.rt.arrangeNativeContinuation=async()=>{continuations++}
   f.store.list=async prefix=>{const rows=await list(prefix);if(first&&prefix===f.prefix+'observations/'){first=false;captured.resolve();await gate.promise}return rows}
   const oldRound=f.rt.observe();await captured.promise
   await f.rt.releaseTask(f.tasks[0]);await f.files.delete(paths.task(f.tasks[0].taskId))
   check('Original Task retirement removed the captured old action before discovery continues',await f.store.get(pending.key),undefined)
   gate.resolve();await oldRound;await drain(f)
   check('Captured retired row cannot reconstruct Task metadata',await withSnapshot(f.files,s=>readJson(f.files,s,paths.task(f.tasks[0].taskId))),undefined)
   check('Captured retired row cannot rewrite its released action body',await f.store.get(pending.key),undefined)
   check('Captured retired row cannot arrange a new execution',continuations,0)
   check('Retired stale discovery has no error',errors,[])
  }finally{await f.close()}
 }
 {
  const f=await fixture(1);let poll,closing
  const gate=defer()
  try{
   const errors=configure(f),pending=await putPending(f,'shutdown-held-delivery'),tx=new FrameworkTransactions(f.files,f.store,f.scope);let delivered=0
   f.rt.arrangeObservation=async()=>{delivered++;await gate.promise}
   f.rt.loop=new FrameworkHostLoop(f.files,tx,f.store,{member:'A',primary:true,scope:f.scope,instanceUUID:'50000000-0000-4000-8000-000000000099'},()=>['A'],{startup:async()=>{},observeLocal:async()=>{},observe:(r,o)=>f.rt.observe(r,o),executing:()=>false,wake:async()=>false,sealBusiness:async()=>{},clean:async()=>false,releaseTask:async()=>{},error:e=>errors.push(String(e))})
   poll=f.rt.loop.poll();await wait(()=>delivered===1)
   let closed=false;closing=f.rt.disposeOwned().then(()=>{closed=true});await tick()
   check('Real disposeOwned also retains the per-record accepted delivery owner',closed,false)
   check('Held delivery remains a single original operation',f.rt.observationOperations.size,1)
   gate.resolve();await poll;await closing
   check('Delivery owner is drained before disposal returns',f.rt.observationOperations.size,0)
   check('Closed runtime does not turn an unfinished action into completed state',(await f.store.get(pending.key)).complete,false)
   check('Closing never adds a replacement delivery',delivered,1)
   check('Accepted delivery drain reports no error',errors,[])
  }finally{gate.resolve();await poll;await closing;await f.close()}
 }
 {
  const f=await fixture(1);let poll,closing,rejectRead
  try{
   const errors=configure(f),entered=defer(),gate=new Promise((_resolve,reject)=>rejectRead=reject),list=f.store.list.bind(f.store)
   f.store.list=async prefix=>{if(prefix===f.prefix+'observations/'){entered.resolve();return gate}return list(prefix)}
   f.rt.loop=new FrameworkHostLoop(f.files,new FrameworkTransactions(f.files,f.store,f.scope),f.store,{member:'A',primary:true,scope:f.scope,instanceUUID:'50000000-0000-4000-8000-000000000099'},()=>['A'],{startup:async()=>{},observeLocal:async()=>{},observe:(r,o)=>f.rt.observe(r,o),executing:()=>false,wake:async()=>false,sealBusiness:async()=>{},clean:async()=>false,releaseTask:async()=>{},error:e=>errors.push(String(e))})
   poll=f.rt.loop.poll();await entered.promise
   const owner=f.rt.maintenance?.get('observation-settlement-discovery'),drainEntered=defer()
   // Only observe Promise.allSettled taking this exact owner, without replacing
   // its fulfillment/rejection or relying on a guessed microtask delay.
   if(owner){const then=owner.then.bind(owner);owner.then=(...args)=>{if(f.rt.closed)drainEntered.resolve();return then(...args)}}
   let closed=false;closing=f.rt.disposeOwned().then(()=>{closed=true;return {resolved:true}},error=>({resolved:false,error:String(error)}))
   if(owner)await drainEntered.promise;else await tick()
   check('Original outstanding discovery is still owned when shutdown reaches its drain',closed,false)
   rejectRead(Error('Controlled outstanding read failure during shutdown'))
   await poll;const outcome=await closing
   check('Reported discovery read failure preserves the original successful disposal behavior',outcome,{resolved:true})
   check('Original discovery failure is reported once even during disposal',errors,['Error: Controlled outstanding read failure during shutdown'])
   check('Failed discovery owner is removed after its original catch finishes',f.rt.maintenance.has('observation-settlement-discovery'),false)
  }finally{await poll;await closing;await f.close()}
 }
 {
  const f=await fixture(0)
  try{
   configure(f);const gate=defer();let reached=false,done=false
   f.rt.files={};f.rt.applyUserControls=async()=>{};f.rt.processObservations=async()=>{reached=true;await gate.promise};f.rt.startRestoration=()=>{}
   const observed=f.rt.observe().then(()=>{done=true});await wait(()=>reached)
   check('Non-Local branch retains its original awaited observation boundary',done,false)
   gate.resolve();await observed
   check('Non-Local branch resumes only after original observation returns',done,true)
  }finally{await f.close()}
 }

 await new Promise(resolve=>process.stdout.write(JSON.stringify({status:'passed',expectedBefore:beforeMode,assertions:checks.length,checks,cases:costs,events,...evidence(),limits:'Baseline/candidate actual production FrameworkHostLoop.poll→runPoll→Runtime.observe→processObservations/startRestoration→restorePending→processRestores, complete Runtime methods extracted unchanged, real physical source conversion via FrameworkTransactions and Host, original producer methods and DSH Context/Storage/Domain/JSON. Independent Foreground publication uses real FrameworkConversation; native wake, arrangeObservation and processRestore are explicit delivery boundaries recording the selected exact request, not native execution tests. Existing heartbeat/sealed business/native-local-tick side subsystems are explicit no-op ports so the tested wait is isolated. A native JSON putRecord is held before completion. Historical rows and running Task metadata are fixture input, not a claimed native history. No shared source change, permanent ID index, live model, network, Windows, typecheck or latency benchmark. Additional checks run original processObservations, arrangeObservation, trackedStop, saveRole and disposeOwned methods. Native send/stop results and continuation/publication are explicit ports; UNKNOWN is unconfirmed, and actual stop confirmation drives real role persistence before continuation. The non-Local awaited branch is a method-level port check, not remote Git verification.'},null,2)+'\n',resolve))
}finally{holdKey=undefined;release?.resolve();JsonStorageBackend.prototype.openUnit=originalOpen;supplemental.deregister();hooks.deregister();await fs.rm(scratch,{recursive:true,force:true})}
