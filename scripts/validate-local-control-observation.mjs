import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createRequire,registerHooks,stripTypeScriptTypes} from 'node:module'
import {pathToFileURL} from 'node:url'
import {sourceRoot,sdkHostRoot,hash,hooks,evidence,loaded} from './test-support/dsh-sdk-runtime.mjs'
import {openDshStorageFixture} from './test-support/dsh-sdk-storage.mjs'
const supplemental=registerHooks({resolve(s,c,n){if(s==='mdast-util-from-markdown')return{url:'data:text/javascript,export function fromMarkdown(){throw Error("Markdown outside controls test")}',shortCircuit:true};return n(s,c)},load(u,c,n){if(u===new URL('framework/skills.ts',sourceRoot).href)return{format:'module',source:'export const frameworkSkillIndexPath="technical/skills/catalog.json";export function isFrameworkSkillDefinitionPath(){throw Error("Skills outside controls test")};export function prepareFrameworkSkillIndex(){throw Error("Skills outside controls test")}',shortCircuit:true};return n(u,c)}})
const require=createRequire(pathToFileURL(path.join(sdkHostRoot,'controls-candidate.mjs')))
const {JsonStorageBackend}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-storage-json')).href)
const {z}=await import(pathToFileURL(require.resolve('zod')).href)
const {PhysicalLocalFiles,LocalTaskRecordParentMissing}=await import('../src/framework/physical-local-files.ts')
const {ExecutionControls}=await import('../src/framework/execution-control.ts')
const {FrameworkHostLoop}=await import('../src/framework/host-loop.ts')
const {FrameworkTaskStateObservation}=await import('../src/framework/task-state-observation.ts')
const {FrameworkTransactions}=await import('../src/framework/command-transactions.ts')
const {preparePhysicalTask,paths,readJson,taskLifecycle,encodeJson}=await import('../src/framework/task-files.ts')
const {readTaskCleanupRecord}=await import('../src/framework/cleaner.ts')
const {withSnapshot,withOperationChannel}=await import('../src/framework/transactions.ts')
const {taskFamily}=await import('../src/framework/task-relations.ts')
const {publishTaskResume}=await import('../src/framework/task-resume.ts')
const {submitTaskCancellation}=await import('../src/framework/task-cancellation.ts')
const {physicalControlSignalSources}=await import('../src/framework/physical-control-signal-sources.ts')
const {GitAuthorityStore}=await import('../src/framework/git-authority.ts')
const {FrameworkConversation}=await import('../src/framework/conversation.ts')
const method=(source,name)=>{const js=stripTypeScriptTypes(source,{mode:'transform'}),m=new RegExp('\\n    (?:async )?'+name+'\\(').exec(js);assert(m,name);const start=m.index+1,next=/\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(js.slice(start+m[0].length));return js.slice(start,next?start+m[0].length+next.index:js.lastIndexOf('\n}'))}
const runtimeSource=readFileSync(new URL('framework/role-runtime.ts',sourceRoot),'utf8'),serviceSource=readFileSync(new URL('framework/service.ts',sourceRoot),'utf8');loaded.set('framework/role-runtime.ts',hash(runtimeSource));loaded.set('framework/service.ts',hash(serviceSource))
const deps={PhysicalLocalFiles,LocalTaskRecordParentMissing,GitAuthorityStore,withSnapshot,withOperationChannel,taskFamily,taskLifecycle,annotateFailure:e=>e}
const Runtime=new Function(...Object.keys(deps),'return class {\n'+['observeLocalTaskState','startLocalTaskStateRead','recheckAdmissionControls','taskControlPublished','taskCancellationPublished','recoverForegroundResetRows','applyUserControls','observe','startMaintenance','retryStartupControls','startTaskControlDiscovery','requestExecutionStop','serialWork','trackedStop','startInChannel','dispose','disposeOwned','settleOperations'].map(n=>method(runtimeSource,n)).join('\n')+'\n}')(...Object.values(deps))
const sd={PhysicalLocalFiles,withOperationChannel,withSnapshot,readTaskCleanupRecord,readJson,paths,taskLifecycle,z,publishTaskResume,submitTaskCancellation,physicalControlSignalSources}
const Service=new Function(...Object.keys(sd),'return class {\n'+method(serviceSource,'taskControl')+'\n'+method(serviceSource,'stopExecution')+'\n}')(...Object.values(sd))
const js=stripTypeScriptTypes(runtimeSource,{mode:'transform'}),start=js.indexOf('taskStateObserved: async '),end=js.indexOf('\n                }',start)+18
assert(start>=0&&end>start);const callback=new Function('PhysicalLocalFiles','return '+js.slice(start+'taskStateObserved: '.length,end).replace(/,\s*$/,'').replace('async (task, snapshot, round)=>','async function(task, snapshot, round)'))(PhysicalLocalFiles)
const checks=[],events=[],errors=[],check=(name,value,expected)=>{assert.deepEqual(value,expected,name);checks.push({name,value})}
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),limit=async(p,label)=>{let t;try{return await Promise.race([p,new Promise((_,j)=>t=setTimeout(()=>j(Error('Unexpected wait '+label)),4000))])}finally{clearTimeout(t)}}
const until=async(f,label)=>{const end=Date.now()+4000;while(!f()){if(Date.now()>end)throw Error('Condition not reached '+label);await sleep(5)}}
const root=await fs.mkdtemp(path.join(os.tmpdir(),'dss-control-candidate-')),fixture=await openDshStorageFixture(path.join(root,'records'),path.join(root,'locator')),store=fixture.adapter,files=new PhysicalLocalFiles(path.join(root,'local'))
const nativeOpen=JsonStorageBackend.prototype.openUnit;let holdKey,release,entered;let holdPromise;let failSettleKey,failOwnerPutKey,unknownAfterPutKey,afterUnknownPut
JsonStorageBackend.prototype.openUnit=async function(...args){const unit=await nativeOpen.apply(this,args);if(args[0].name==='record'){const put=unit.putRecord.bind(unit);unit.putRecord=async(t,k,v)=>{if(k===holdKey){entered();await holdPromise}if(k===failSettleKey&&JSON.stringify(v).includes('superseded'))throw Error('controlled exact settlement failure');if(k===failOwnerPutKey){failOwnerPutKey=undefined;throw Error('controlled owner write rejected before native put')}return put(t,k,v)}}return unit}
function hold(key){holdKey=key;let enter;const pending=new Promise(r=>enter=r);entered=enter;holdPromise=new Promise(r=>release=r);return pending}
const scope='control-candidate',instanceUUID='10000000-0000-4000-8000-000000000003',controlRoot='framework-user-controls/'+hash(scope),controls=new ExecutionControls(store,scope,undefined,files,store,instanceUUID),tx=new FrameworkTransactions(files,store,scope)
let listCalls=[],getCalls=[],entriesVisited=0;const set=store.set.bind(store),get=store.get.bind(store),list=store.list.bind(store),entries=store.records.table.entries.bind(store.records.table)
store.set=async(k,v)=>{await set(k,v);if(k===unknownAfterPutKey){unknownAfterPutKey=undefined;afterUnknownPut?.();throw Error('controlled UNKNOWN after native storage acceptance')}};store.get=async k=>{getCalls.push(k);return get(k)};store.list=async p=>{listCalls.push(p);return list(p)};store.records.table.entries=function*(){for(const row of entries()){entriesVisited++;yield row}}
let physicalGetCalls=[];const physicalRead=files.readBytes.bind(files);files.readBytes=async(s,p)=>{physicalGetCalls.push(p);return physicalRead(s,p)}
const physicalUpdate=files.updateInExistingDirectory.bind(files)
files.updateInExistingDirectory=async(p,decide,signal)=>{
 const result=await physicalUpdate(p,async bytes=>{const result=await decide(bytes);if(p===holdKey){entered();await holdPromise}return result},signal)
 if(p===unknownAfterPutKey){unknownAfterPutKey=undefined;afterUnknownPut?.();throw Error('controlled UNKNOWN after physical atomic rename')}
 return result
}
const nativeModes=new Map(),stops=[]
function runtime(){const rt=new Runtime();Object.assign(rt,{files,controls,records:store,roleRecords:new Map(),workOperations:new Map(),pendingTaskStateReads:new Map(),localWakeAdmissions:new Map(),reportedAdmissionDiagnostics:new Set(),pendingControlStops:[],pendingTaskControlDiscovery:new Map(),startupControlsDiscovered:false,closed:false,environment:{heartbeat:async()=>{},changed(){}},retryStartupTasks(){},processObservations:async()=>{},startRestoration(){},processSealedBusiness:async()=>{},startOwnedPump(){},scheduleTaskResume(){},error(e,c){errors.push({message:String(e),context:c})},roleKey:r=>r,organizerWakeWrites:new Map(),cleanupResidues:new Map(),targetedPumps:new Map(),cleaner:{close(){}},loop:{ownsPhysicalTaskCleanup:()=>false,stop:async()=>{}},observations:{dispose:async()=>{}},native:{cancelOpening:async()=>({status:'stopped'})},currentTask:async r=>r.identity.taskId,ownedAsyncContext:f=>f(),safetyCommandFor:()=>undefined,saveRole:async r=>{await store.set('framework-runtime/'+hash(scope)+'/roles/'+hash(r.identity.workId),r);rt.roleRecords.set(r.identity.workId,r)},stopOwnedRecord:async r=>{stops.push(r.identity.executionId);events.push('stop:'+r.identity.executionId);return nativeModes.get(r.identity.executionId)??{status:'stopped'}}});return rt}
const rt=runtime(),updates=[],projection=new FrameworkTaskStateObservation(u=>{updates.push(u);events.push('state:'+u.task.taskId+':'+u.task.control)},e=>errors.push({message:String(e)}),'local');rt.taskStateObservation=projection
const makeRole=(task,execution='execution-'+task,role='Planner')=>({identity:{taskId:task,workId:role+'-'+task,executionId:execution,role},sessionId:'session-'+execution,generation:1})
const discovered=[],wakes=[]
const host=new FrameworkHostLoop(files,tx,store,{member:'A',primary:true,scope,instanceUUID},()=>['A'],{startup:async()=>{},observeLocal:async()=>{},observe:(_,o)=>rt.observe(undefined,o),readRoundStarted:o=>projection.begin(o),taskStateEntries:(e,s,o)=>projection.listed(o,s.revision,e),taskStateObserved:callback.bind(rt),discoverTask:async t=>{discovered.push(t.taskId);events.push('discover:'+t.taskId)},executing:()=>false,wake:async w=>{wakes.push(w);return false},sealBusiness:async()=>{},clean:async()=>false,releaseTask:async()=>{},error:e=>errors.push({message:String(e)})})
const connection={files,scope,transactions:tx,sharedRecords:store,records:store,identity:{instanceUUID},registration:{member:'A'}},svc=new Service();svc.running=new Map([['local',{connection,runtime:rt}]]);svc.withAccessOperation=async(i,f)=>f({connection,commandHostKey:'audit'});svc.controls=()=>controls;svc.beforeLocalTaskUse=async()=>true;svc.access=async()=>({connection});svc.checkScope=()=>{}
const drain=async r=>{for(let n=0;n<20;n++){const pending=[...(r.maintenance?.values()??[])];if(!pending.length)return;await limit(Promise.allSettled(pending),'maintenance');await sleep(0)}throw Error('maintenance did not drain')}
try{
 for(const name of ['A','B'])await files.replace('tasks/'+name+'_P.md',name+' original user objective')
 await host.poll();await drain(rt)
 const ids=[];for(const name of ['A','B'])ids.push(/Task ID: ([a-f0-9-]+)/.exec(await withSnapshot(files,s=>files.read(s,'tasks/'+name+'_P.md')))[1]);const[a,b]=ids
 for(const id of ids)rt.roleRecords.set('Planner-'+id,makeRole(id))
 check('Cold discovery finishes without persistent control index',rt.pendingControlStops,[]);check('Original cold discovery completes once',rt.startupControlsDiscovered,true)
 listCalls=[];getCalls=[];entriesVisited=0;discovered.length=0;updates.length=0
 const nativeEntered=hold(controls.taskRecordPath(a));const pa=svc.taskControl({mode:'local',commandId:'pause-A',taskId:a,intent:'paused'});await limit(nativeEntered,'A write enters')
 check('B real Service pause independent',(await limit(svc.taskControl({mode:'local',commandId:'pause-B',taskId:b,intent:'paused'}),'B pause')).submitted,true)
 check('B real Service resume independent',(await limit(svc.taskControl({mode:'local',commandId:'resume-B',taskId:b,intent:'running'}),'B resume')).submitted,true)
 const conversation=new FrameworkConversation(files,tx,{mode:'local',collaborationId:'test'});await conversation.send('fg',{id:'fg',participantId:'user',createdAt:new Date().toISOString(),role:'user',recipient:'ai',text:'Original foreground input'})
 let pollDone=false;const poll=host.poll().then(()=>pollDone=true)
 await until(()=>discovered.includes(b)&&wakes.some(w=>w.taskId===b&&w.role==='Planner')&&wakes.some(w=>w.role==='Foreground'),'B discovery and role dispatch without A');check('Held A does not withhold B discovery',discovered.includes(b),true);check('B completed UI state arrives while A write pending',updates.some(u=>u.task.taskId===b&&u.task.control==='running'),true);check('B Planner wake independent of A pause write',wakes.some(w=>w.taskId===b&&w.role==='Planner'),true);check('Foreground signal remains independent',wakes.some(w=>w.role==='Foreground'),true);check('Explicit business poll does not wait for independent display reads',pollDone,true);check('Warm control path performs no prefix scans',listCalls.filter(k=>k.startsWith(controlRoot)).length,0)
 // A later common poll can discover B while the first poll still owns A.
 const follow=host.poll();await sleep(25);check('No false A stopped result before accepted pause',rt.roleRecords.get('Planner-'+a).stopped,undefined)
 release();holdKey=undefined;await limit(Promise.all([pa,poll,follow]),'A completion');await drain(rt)
 check('A original pause retained',(await controls.task(a)).intent,'paused');check('A state from slow earlier lane is not discarded',updates.some(u=>u.task.taskId===a&&u.task.control==='paused'),true);check('A native stop is exact after pause',rt.roleRecords.get('Planner-'+a).stopped,true);check('B is not stopped by A pause',rt.roleRecords.get('Planner-'+b).stopped,undefined)
 // Real pause/resume/cancel and reciprocal parent control resolution.
 const parentId='40000000-0000-4000-8000-000000000001',childId='40000000-0000-4000-8000-000000000002'
 const parent={version:1,taskId:parentId,route:'O',owner:'A',members:['A'],status:'running',sourcePath:'tasks/parent_O.md',children:[{taskId:childId,member:'A',objectiveId:'child'}]},child={version:1,taskId:childId,route:'P',owner:'A',members:['A'],status:'running',sourcePath:'tasks/child_P.md',parent:{taskId:parentId,owner:'A',objectiveId:'child'}}
 for(const t of [parent,child]){await files.replace(paths.task(t.taskId),encodeJson(t));await files.replace(t.sourcePath,'Task ID: '+t.taskId+'\nOriginal requirement');await files.replace(paths.inbox(t.taskId,'A'),'accepted work')}
 await svc.taskControl({mode:'local',commandId:'pause-parent',taskId:parentId,intent:'paused'});check('Child inherits reciprocal parent pause',(await withSnapshot(files,s=>controls.taskStates([child],s))).get(childId).intent,'paused');check('Unrelated B remains running',(await controls.task(b)).intent,'running')
 getCalls=[];listCalls=[];physicalGetCalls=[];await withSnapshot(files,s=>controls.taskStates([child],s));check('Parent inheritance reads only child and parent physical control files',physicalGetCalls.filter(k=>k.endsWith('/control.json')).sort(),[controls.taskRecordPath(parentId),controls.taskRecordPath(childId)].sort());check('Parent inheritance does not read Task SDK owners',getCalls.filter(k=>k.startsWith(controlRoot+'/tasks/')),[]);check('Parent inheritance has no prefix discovery',listCalls,[])
 // A task-family target must retain its full existing role scope, not use the exact-work shortcut.
 const familyRuntime=runtime();for(const role of [makeRole(parentId,'family-organizer','Organizer'),makeRole(childId,'family-child'),makeRole(b,'family-unrelated')])familyRuntime.roleRecords.set(role.identity.workId,role)
 listCalls=[];await familyRuntime.applyUserControls(true,{taskId:parentId});await drain(familyRuntime)
 check('Task-family pause still stops its Organizer',familyRuntime.roleRecords.get('Organizer-'+parentId).stopped,true)
 check('Task-family pause still stops its child Planner',familyRuntime.roleRecords.get('Planner-'+childId).stopped,true)
 check('Task-family pause excludes unrelated role',familyRuntime.roleRecords.get('Planner-'+b).stopped,undefined)
 check('Task-family control handling uses no technical prefix query',listCalls.filter(k=>k.startsWith(controlRoot)),[])
 await svc.taskControl({mode:'local',commandId:'resume-parent',taskId:parentId,intent:'running'});check('Child resume no lingering inherited hold',(await controls.task(childId))?.intent,undefined)
 check('Service terminal cancellation accepted',(await svc.taskControl({mode:'local',commandId:'cancel-parent',taskId:parentId,intent:'cancelled'})).submitted,true);for(const id of [parentId,childId])check('Cancellation writes actual terminal status '+id,(await withSnapshot(files,s=>readJson(files,s,paths.task(id)))).status,'cancelled');check('Only root Recorder signal exists',await withSnapshot(files,async s=>(await files.read(s,paths.state('A',parentId)+'/Recorder'))!==undefined&&(await files.read(s,paths.state('A',childId)+'/Recorder'))===undefined),true)
 await assert.rejects(()=>svc.taskControl({mode:'local',commandId:'resume-cancelled',taskId:parentId,intent:'running'}),/cannot be reopened/);checks.push({name:'Cancelled Task cannot resume',value:true})
 // Actual service stop entry and runtime trackedStop, with native stop a declared seam.
 let record=rt.roleRecords.get('Planner-'+b);check('Exact stop Service submits',(await svc.stopExecution({mode:'local',commandId:'stop-B',workId:record.identity.workId,executionId:record.identity.executionId})).submitted,true);await drain(rt);check('Exact stop receipt confirms stopped',(await controls.execution(record.identity)).result.state,'stopped')
 const unknown=makeRole(b,'execution-unknown');rt.roleRecords.set(unknown.identity.workId,unknown);nativeModes.set(unknown.identity.executionId,{status:'unconfirmed',reason:'actual producer still owns work',jobs:['job-original']});await svc.stopExecution({mode:'local',commandId:'stop-unknown',workId:unknown.identity.workId,executionId:unknown.identity.executionId});await drain(rt);check('UNKNOWN is retained as unconfirmed',(await controls.execution(unknown.identity)).result.state,'unconfirmed');check('UNKNOWN retains original jobs',(await controls.execution(unknown.identity)).result.jobs,['job-original']);check('UNKNOWN does not become stopped',rt.roleRecords.get(unknown.identity.workId).stopped,undefined)
 const stale=makeRole(b,'execution-stale');rt.roleRecords.set(stale.identity.workId,stale);await controls.requestExecutionStop('stop-stale',stale.identity);const replacement={...stale,identity:{...stale.identity,executionId:'replacement'},generation:2};rt.roleRecords.set(stale.identity.workId,replacement);await rt.applyUserControls(true,{workId:stale.identity.workId,executionId:stale.identity.executionId,owner:{taskId:b}});check('Replacement settles only old request',(await controls.execution(stale.identity)).result.state,'superseded');check('Replacement producer is never stopped',stops.includes('replacement'),false)
 // Two and three exact stop attempts overlap at the original settlement boundary.
 for(const count of [2,3]){
  const race=runtime();race.startupControlsDiscovered=true;const raceRole=makeRole(b,'execution-stop-overlap-'+count);race.roleRecords.set(raceRole.identity.workId,raceRole)
  const firstCommand='overlap-first-'+count,lastCommand='overlap-'+count+'-'+count
  const settle=controls.settleExecution.bind(controls);let settleEntered,settleRelease;const settleArrival=new Promise(r=>settleEntered=r),settleGate=new Promise(r=>settleRelease=r)
  controls.settleExecution=async(...args)=>{if(args[0]===firstCommand){settleEntered();await settleGate}return settle(...args)}
  try {
   await race.requestExecutionStop(firstCommand,raceRole.identity.workId,raceRole.identity.executionId);await limit(settleArrival,'first stop before exact settlement')
   for(let i=2;i<=count;i++){
    const command='overlap-'+count+'-'+i
    if(count===3&&i===3){unknownAfterPutKey=controls.taskRecordPath(b);afterUnknownPut=undefined
     await assert.rejects(()=>race.requestExecutionStop(command,raceRole.identity.workId,raceRole.identity.executionId),/controlled UNKNOWN/);checks.push({name:'Third overlapping command keeps original UNKNOWN response',value:true})
    }else await race.requestExecutionStop(command,raceRole.identity.workId,raceRole.identity.executionId)
   }
   check(count+' latest original stop command really replaces the first control owner',(await controls.execution(raceRole.identity)).commandId,lastCommand)
   race.roleRecords.set(raceRole.identity.workId,{...raceRole,identity:{...raceRole.identity,executionId:'replacement-after-overlap-'+count},generation:2});settleRelease();await drain(race)
   const afterOld={pending:race.pendingControlStops.map(({write,...target})=>structuredClone(target)),control:await controls.execution(raceRole.identity)}
   check(count+' original later attempts survive the old maintenance completion',afterOld.pending.length,count-1)
   for(let tick=0;tick<count;tick++){await race.observe();await drain(race)}
   const afterNext=await controls.execution(raceRole.identity)
   if(process.env.DSS_CONTROL_AUDIT_OUTPUT)await fs.writeFile(path.join(process.env.DSS_CONTROL_AUDIT_OUTPUT,(count===2?'stop-overlap':'stop-overlap-three')+(afterNext.result?'-after.json':'-before.json')),JSON.stringify({afterOld,afterNext,sourceHash:hash(runtimeSource),limits:'Actual requestExecutionStop, ExecutionControls request/settle and SDK; only the first exact settlement is held. The first native stop completes through the declared native result seam before later valid stop buttons, then same workId is replaced. Three-command case makes the latest original physical atomic rename acknowledgement UNKNOWN.'},null,2)+'\n')
   check(count+' accepted stops survive first settlement and role replacement',afterNext.result?.state,'superseded')
   check(count+' overlap never stops replacement producer',stops.includes('replacement-after-overlap-'+count),false)
   check(count+' overlap invokes native stop only for the original execution',stops.filter(id=>id===raceRole.identity.executionId).length,1)
   check(count+' original responsibilities finish without retained index',race.pendingControlStops,[])
  } finally {settleRelease();controls.settleExecution=settle;unknownAfterPutKey=undefined;afterUnknownPut=undefined}
 }
 // The real control write commits then throws UNKNOWN after role replacement.
 const uncertain=makeRole(b,'execution-uncertain-write');rt.roleRecords.set(uncertain.identity.workId,uncertain)
 unknownAfterPutKey=controls.taskRecordPath(b)
 afterUnknownPut=()=>rt.roleRecords.set(uncertain.identity.workId,{...uncertain,identity:{...uncertain.identity,executionId:'replacement-after-unknown'},generation:2})
 await assert.rejects(()=>svc.stopExecution({mode:'local',commandId:'stop-after-unknown',workId:uncertain.identity.workId,executionId:uncertain.identity.executionId}),/controlled UNKNOWN/);checks.push({name:'Original UNKNOWN response remains UNKNOWN',value:true});await drain(rt)
 check('Accepted old execution request is settled after write UNKNOWN and replacement',(await controls.execution(uncertain.identity)).result.state,'superseded');check('Post-UNKNOWN replacement is not stopped',stops.includes('replacement-after-unknown'),false);check('Original UNKNOWN attempt responsibility is released only after exact result',rt.pendingControlStops.some(t=>t.executionId===uncertain.identity.executionId),false)
 // The independent no-Task Foreground branch still has an SDK command claim.
 // Task claim-only fixtures were removed: Task controls use one atomic file.
 // Neither old pendingStops nor exact execution reads treat a claim alone as an accepted owner stop.
 const rejected={identity:{role:'Foreground',workId:'unbound-foreground',executionId:'execution-owner-put-rejected'},sessionId:'unbound-session',generation:1},rejectedCommand='owner-put-rejected';rt.roleRecords.set(rejected.identity.workId,rejected);failOwnerPutKey=controlRoot+'/executions/'+hash(rejected.identity.executionId)
 await assert.rejects(()=>svc.stopExecution({mode:'local',commandId:rejectedCommand,workId:rejected.identity.workId,executionId:rejected.identity.executionId}),/controlled owner write rejected before native put/);checks.push({name:'Owner pre-put rejection remains an explicit caller failure',value:true});await drain(rt)
 const claimBeforeRetry=await store.get(controlRoot+'/commands/'+hash(rejectedCommand))
 check('Original command claim is retained after rejected owner write',claimBeforeRetry?.value.executionId,rejected.identity.executionId)
 check('Actual SDK has no execution owner row after rejected put',await controls.execution(rejected.identity),undefined)
 check('Original prefix pendingStops also does not discover claim-only request',(await controls.pendingStops(undefined,()=>{})).some(request=>request.executionId===rejected.identity.executionId),false)
 check('Claim-only failure does not invoke native stop',stops.includes(rejected.identity.executionId),false)
 check('No accepted owner request is fabricated for claim-only failure',rt.pendingControlStops.some(target=>target.executionId===rejected.identity.executionId),false)
 await svc.stopExecution({mode:'local',commandId:rejectedCommand,workId:rejected.identity.workId,executionId:rejected.identity.executionId});await drain(rt)
 const retriedOwner=await controls.execution(rejected.identity)
 check('Explicit same-command UI retry reuses the original claim',[retriedOwner.commandId,retriedOwner.requestedAt],[rejectedCommand,claimBeforeRetry.value.requestedAt])
 check('Explicit same-command retry settles its actual owner stop',retriedOwner.result.state,'stopped')
 if(process.env.DSS_CONTROL_AUDIT_OUTPUT)await fs.writeFile(path.join(process.env.DSS_CONTROL_AUDIT_OUTPUT,'claim-only-rejection.json'),JSON.stringify({claimBeforeRetry,retriedOwner,sourceHash:hash(runtimeSource),boundary:'Actual command claim put succeeds, owner JsonStorageBackend.putRecord is rejected before invocation. Original prefix discovery and exact read both find no execution owner; no automatic intent replay is added. Explicit same-command Service retry retains claim identity and reaches the declared native stop result seam.'},null,2)+'\n')
 // No-Task SDK cold orphan discovery failure, settlement failure, then retries. Known-Task file discovery is tested separately through real Host discovery/recovery.
 const cold=runtime(),orphan={workId:'no-current-role',executionId:'execution-orphan'};await controls.requestExecutionStop('stop-orphan',orphan);const orphanPeer={workId:'no-current-peer',executionId:'execution-orphan-peer'};await controls.requestExecutionStop('stop-orphan-peer',orphanPeer)
 const originalPending=controls.pendingStops.bind(controls);let coldDiscoveries=0;controls.pendingStops=async(...args)=>{coldDiscoveries++;if(coldDiscoveries===1)throw Error('controlled cold discovery failure');return originalPending(...args)}
 cold.retryStartupControls();await drain(cold);check('Cold discovery failure leaves host open',cold.closed,false);check('Failed discovery remains unfinished',cold.startupControlsDiscovered,false)
 failSettleKey=controlRoot+'/executions/'+hash(orphan.executionId);cold.retryStartupControls();await drain(cold);check('Exact failed orphan remains owned',cold.pendingControlStops.some(t=>t.executionId===orphan.executionId),true);check('Cold recovery settles other superseded IDs independently',cold.pendingControlStops.filter(t=>t.executionId!==orphan.executionId).length,0);check('Sibling original cold request settled despite failed peer',(await controls.execution(orphanPeer)).result.state,'superseded')
 failSettleKey=undefined;cold.retryStartupControls();await drain(cold);check('Orphan exact settlement retry succeeds',(await controls.execution(orphan)).result.state,'superseded');check('Successful cold original list is fully released',cold.pendingControlStops,[]);check('Settlement retry never repeats successful discovery',coldDiscoveries,2);cold.retryStartupControls();await drain(cold);check('Completed startup never rediscovers',coldDiscoveries,2);controls.pendingStops=originalPending
 // Actual startInChannel must not wait for cold control discovery.
 const boot=runtime();let releaseCold;const coldGate=new Promise(r=>releaseCold=r);let bootLoopStarted=false
 Object.assign(boot,{roleBases:new Map(),config:{mode:'local'},prefix:'framework-runtime/'+hash(scope)+'/',discoverRoles:async()=>[],continueNativeRetirements(){},reconcileWorkerTransfers:async()=>{},continueInitialization(){},loop:{start:async()=>{bootLoopStarted=true;await boot.observe()},stop:async()=>{}}})
 controls.pendingStops=async()=>{await coldGate;throw Error('controlled boot discovery failure')}
 await limit(boot.startInChannel(),'boot with unresolved cold discovery');check('Actual startInChannel enters loop before cold discovery resolves',bootLoopStarted,true);releaseCold();await drain(boot);check('Cold failure after actual start leaves loop active',boot.closed,false);controls.pendingStops=originalPending
 // Actual disposeOwned joins an already accepted, exact cold-settlement write.
 const closingTarget={workId:'closing-orphan',executionId:'execution-closing'};await controls.requestExecutionStop('closing-command',closingTarget)
 const closer=runtime(),closingEntered=hold(controlRoot+'/executions/'+hash(closingTarget.executionId));closer.retryStartupControls();await limit(closingEntered,'cold settlement enters before dispose')
 let disposed=false;const disposal=closer.dispose().then(()=>disposed=true);await sleep(25);check('Actual dispose waits for original maintenance settlement',disposed,false);check('Closing flag prevents new admission',closer.closed,true);release();holdKey=undefined;await limit(disposal,'dispose drains exact settlement');check('Accepted cold request result survives shutdown',(await controls.execution(closingTarget)).result.state,'superseded');check('Cold original responsibility removed after successful shutdown drain',closer.pendingControlStops,[])
 // Same-Task command order is retained while a peer Task remains independent.
 const orderedEntered=hold(controls.taskRecordPath(b));const first=svc.taskControl({mode:'local',commandId:'ordered-pause-B',taskId:b,intent:'paused'});await limit(orderedEntered,'ordered pause');let resumeReturned=false;const second=svc.taskControl({mode:'local',commandId:'ordered-resume-B',taskId:b,intent:'running'}).then(v=>{resumeReturned=true;return v});await sleep(25);check('Same Task resume does not overtake unconfirmed pause',resumeReturned,false);check('Different Task exact control remains available during ordered B writes',(await limit(controls.task(a),'peer exact read')).intent,'paused');release();holdKey=undefined;await limit(Promise.all([first,second]),'ordered pause then resume');check('Same Task final control is the later resume',(await controls.task(b)).intent,'running')
 // Generation fencing and unrelated-round completion use the actual display class.
 const late={},newer={};projection.begin(late);projection.begin(newer);projection.localTask(newer,'view-B',child,undefined);const before=updates.length;projection.localTask(late,'view-A',parent,{intent:'paused'});check('Independent newer round does not discard completed older Task lane',updates.length,before+1);projection.viewBoundary();projection.localTask(late,'view-old',parent,{intent:'running'});check('UI authoritative-read generation rejects obsolete completion',updates.length,before+1)
 // Warm cost: two old prefix queries visit every loaded record, versus exact role keys.
 listCalls=[];getCalls=[];entriesVisited=0;const size=[...entries()].length;await controls.pendingStops(undefined,()=>{});const baseline={listCalls:[...listCalls],entriesVisited,tableRecords:size};listCalls=[];entriesVisited=0;await controls.pendingStops();check('Cold execution-only discovery does not enumerate Task controls',listCalls,[controlRoot+'/executions/']);listCalls=[];getCalls=[];physicalGetCalls=[];entriesVisited=0;await rt.applyUserControls(false);await drain(rt);const warm={listCalls:[...listCalls],entriesVisited,controlGets:getCalls.filter(k=>k.startsWith(controlRoot)),physicalControlReads:physicalGetCalls.filter(k=>k.endsWith('/control.json'))};check('Baseline control discovery traverses full Map twice',baseline.entriesVisited,size*2);check('Candidate warm observation has no prefix query',warm.listCalls.length,0);check('Candidate exact lookup does not enumerate technical Storage Map',warm.entriesVisited,0)
 // Actual applyUserControls Git/readRound branch, with explicit controlled authority ports.
 // The comparison reverses only the three-line in-memory target lookup hunk.
 // It does not simulate remote commits or claim an actual Git transport test.
 const lookupHunk="    const exactTarget = waitTarget?.workId !== undefined && waitTarget.executionId !== undefined && waitTarget.taskId === undefined\n    const exactRecord = exactTarget ? this.roleRecords.get(waitTarget.workId!) : undefined\n    const candidates = exactTarget ? (exactRecord ? [exactRecord] : []) : [...this.roleRecords.values()]\n    for (const candidate of candidates) {"
 assert(runtimeSource.includes(lookupHunk),'Exact lookup source hunk remains explicit')
 const previousTargetSource=runtimeSource.replace(lookupHunk,'    for (const candidate of [...this.roleRecords.values()]) {')
 const PreviousTargetRuntime=new Function(...Object.keys(deps),'Runtime','return class extends Runtime {\n'+method(previousTargetSource,'applyUserControls')+'\n}')(...Object.values(deps),Runtime)
 const gitTargetCheck=async(klass,replaced)=>{
  const target=runtime();Object.setPrototypeOf(target,klass.prototype);target.files={};const trace=[],selected={workId:'git-work-B',executionId:'git-execution-B'},requests=['A','B'].map(id=>({workId:'git-work-'+id,executionId:'git-execution-'+id,taskId:'git-task-'+id,commandId:'git-command-'+id}))
  target.roleRecords=new Map(requests.map(request=>[request.workId,{identity:{role:'Planner',taskId:request.taskId,workId:request.workId,executionId:replaced&&request.workId===selected.workId?'git-replacement':request.executionId},stopped:true}]))
  let visits=0;const values=target.roleRecords.values.bind(target.roleRecords);target.roleRecords.values=function*(){for(const value of values()){visits++;yield value}}
  const snapshot={revision:'controlled-fixed-Git-view'},round={withSnapshot:async read=>{trace.push('readRound');return read(snapshot)}}
  target.taskStateObservation={controls:(r,revision,values)=>{assert.equal(r,round);trace.push(['controls',revision,values])}}
  target.controls={pendingStops:async(s,observe)=>{assert.equal(s,snapshot);trace.push('pendingStops-fixed-view');observe([]);return requests},execution:async()=>{throw Error('Git branch must preserve its authority read, not use Local exact control reads')},settleExecution:async(commandId,executionId,result)=>{trace.push(['settle',commandId,executionId,result]);return undefined}}
  await target.applyUserControls(true,selected,round)
  return{trace,visits}
 }
 for(const replaced of [false,true]){
  const before=await gitTargetCheck(PreviousTargetRuntime,replaced),after=await gitTargetCheck(Runtime,replaced)
  check('Git exact target '+(replaced?'superseded':'current')+' keeps original readRound, authority reads and results',after.trace,before.trace)
  check('Git exact target settles only the addressed original execution '+replaced,after.trace.filter(x=>Array.isArray(x)&&x[0]==='settle'),[['settle','git-command-B',{workId:'git-work-B',executionId:'git-execution-B',taskId:'git-task-B',commandId:'git-command-B'},{state:replaced?'superseded':'stopped'}]])
  check('Git exact target narrows only role Map enumeration '+replaced,[before.visits,after.visits],[2,0])
 }
 // Count current-role enumeration separately from technical Storage Map visits.
 const counted=runtime();counted.startupControlsDiscovered=true;const R=4
 for(let i=0;i<R;i++){
  const id='60000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),source='tasks/count-'+i+'_P.md';await files.replace(source,'Original independent count task '+i);await withSnapshot(files,s=>preparePhysicalTask(files,s,source,{taskId:id,owner:'A',members:['A']}));await counted.saveRole({...makeRole(id),stopped:true})
 }
 let roleVisits=0,roleValueCalls=0;const roleValues=counted.roleRecords.values.bind(counted.roleRecords)
 counted.roleRecords.values=function*(){roleValueCalls++;for(const value of roleValues()){roleVisits++;yield value}}
 await counted.applyUserControls(false);await drain(counted)
 const enumeration={roles:R,valuesCalls:roleValueCalls,roleValuesVisited:roleVisits,sourceHash:hash(runtimeSource)}
 if(process.env.DSS_CONTROL_AUDIT_OUTPUT)await fs.writeFile(path.join(process.env.DSS_CONTROL_AUDIT_OUTPUT,roleVisits===R?'role-enumeration-after.json':'role-enumeration-before.json'),JSON.stringify(enumeration,null,2)+'\n')
 check('Exact per-execution work does not re-enumerate every current role',roleVisits,R)
 console.log(JSON.stringify({status:'passed',assertions:checks.length,checks,cost:{baseline,warm,currentRoles:enumeration},events,expectedErrors:errors,...evidence(),limits:'Actual recovered SDK storage and schemas; unchanged Service taskControl/stopExecution plus isolated candidate runtime control/observation methods, Host.poll, display projector and physical cancellation/resume. Native producer stop is an explicit result seam and saveRole persistence is a narrow exact-record seam, so no installed native Agent, Windows latency or complete-runtime acceptance is claimed. Existing wake-prefix and other observation lanes are not changed by this candidate.'},null,2))
}finally{release?.();holdKey=undefined;failSettleKey=undefined;rt.closed=true;await host.stop();await drain(rt);await files.close();await fixture.close();JsonStorageBackend.prototype.openUnit=nativeOpen;supplemental.deregister();hooks.deregister();await fs.rm(root,{recursive:true,force:true})}
