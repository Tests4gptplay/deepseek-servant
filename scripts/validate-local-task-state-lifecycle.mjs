import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createRequire,registerHooks,stripTypeScriptTypes} from 'node:module'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
// Project regression: each case owns a fresh actual SDK fixture and no model/account.
if(!process.env.DSS_CONTROL_CASE){
 const results=[]
 for(const scenario of ['cost2','cost8','costfamily','timer','busy','states','cleaner']){
  const child=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(import.meta.url)],{encoding:'utf8',timeout:30000,env:{...process.env,DSS_CONTROL_CASE:scenario}})
  let result;try{result=JSON.parse(child.stdout)}catch{result={stdout:child.stdout}}
  results.push({scenario,exit:child.status,result,...child.status?{error:child.stderr}: {}})
 }
 const passed=results.every(r=>r.exit===0)
 await new Promise(resolve=>process.stdout.write(JSON.stringify({status:passed?'passed':'failed',assertions:results.reduce((n,r)=>n+(r.result.checks?.length??0),0),results,limits:'Actual project methods, SDK storage and physical tools; explicit model/native and no-link Markdown boundary ports are stated inside every case. No remote Git or Windows execution is claimed.'},null,2)+'\n',resolve))
 process.exit(passed?0:1)
}
const selectedSource=process.env.DSS_CONTROL_SOURCE_ROOT??fileURLToPath(new URL('../',import.meta.url))
const {sourceRoot,sdkHostRoot,hash,hooks,evidence,loaded}=await import(pathToFileURL(path.join(selectedSource,'scripts/test-support/dsh-sdk-runtime.mjs')).href)
const {openDshStorageFixture}=await import(pathToFileURL(path.join(selectedSource,'scripts/test-support/dsh-sdk-storage.mjs')).href)
const supplemental=registerHooks({resolve(s,c,n){if(s==='mdast-util-from-markdown')return{url:'data:text/javascript,export function fromMarkdown(text){if(/[\[\]<>]/.test(text))throw Error("Link markdown outside plain-text fixture");return {type:"root",children:[]}}',shortCircuit:true};return n(s,c)},load(u,c,n){if(u===new URL('framework/skills.ts',sourceRoot).href)return{format:'module',source:'export const frameworkSkillIndexPath="technical/skills/catalog.json";export function isFrameworkSkillDefinitionPath(){throw Error("Skills outside controls test")};export function prepareFrameworkSkillIndex(){throw Error("Skills outside controls test")}',shortCircuit:true};return n(u,c)}})
const require=createRequire(pathToFileURL(path.join(sdkHostRoot,'controls-candidate.mjs')))
const {JsonStorageBackend}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-storage-json')).href)
const {z}=await import(pathToFileURL(require.resolve('zod')).href)
const {PhysicalLocalFiles,LocalTaskRecordParentMissing}=await import(new URL('framework/physical-local-files.ts',sourceRoot).href)
const {ExecutionControls}=await import(new URL('framework/execution-control.ts',sourceRoot).href)
const {FrameworkHostLoop}=await import(new URL('framework/host-loop.ts',sourceRoot).href)
const {FrameworkTaskStateObservation}=await import(new URL('framework/task-state-observation.ts',sourceRoot).href)
const {FrameworkTransactions}=await import(new URL('framework/command-transactions.ts',sourceRoot).href)
const {preparePhysicalTask,paths,readJson,taskLifecycle,encodeJson}=await import(new URL('framework/task-files.ts',sourceRoot).href)
const {FrameworkCleaner,readTaskCleanupRecord}=await import(new URL('framework/cleaner.ts',sourceRoot).href)
const {withSnapshot,withOperationChannel}=await import(new URL('framework/transactions.ts',sourceRoot).href)
const {taskFamily}=await import(new URL('framework/task-relations.ts',sourceRoot).href)
const {publishTaskResume}=await import(new URL('framework/task-resume.ts',sourceRoot).href)
const {submitTaskCancellation}=await import(new URL('framework/task-cancellation.ts',sourceRoot).href)
const {physicalControlSignalSources}=await import(new URL('framework/physical-control-signal-sources.ts',sourceRoot).href)
const {installFrameworkRoleTools}=await import(new URL('framework/role-tools.ts',sourceRoot).href)
const {GitAuthorityStore}=await import(new URL('framework/git-authority.ts',sourceRoot).href)
const {FrameworkConversation}=await import(new URL('framework/conversation.ts',sourceRoot).href)
const method=(source,name)=>{const js=stripTypeScriptTypes(source,{mode:'transform'}),m=new RegExp('\\n    (?:async )?'+name+'\\(').exec(js);assert(m,name);const start=m.index+1,next=/\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(js.slice(start+m[0].length));return js.slice(start,next?start+m[0].length+next.index:js.lastIndexOf('\n}'))}
const runtimeSource=readFileSync(new URL('framework/role-runtime.ts',sourceRoot),'utf8'),serviceSource=readFileSync(new URL('framework/service.ts',sourceRoot),'utf8');loaded.set('framework/role-runtime.ts',hash(runtimeSource));loaded.set('framework/service.ts',hash(serviceSource))
const deps={PhysicalLocalFiles,LocalTaskRecordParentMissing,GitAuthorityStore,withSnapshot,withOperationChannel,taskFamily,taskLifecycle,annotateFailure:e=>e}
const Runtime=new Function(...Object.keys(deps),'return class {\n'+['observeLocalTaskState','startLocalTaskStateRead','recheckAdmissionControls','taskControlPublished','applyUserControls','observe','startMaintenance','retryStartupControls','startTaskControlDiscovery','requestExecutionStop','serialWork','trackedStop','startInChannel','dispose','disposeOwned','settleOperations'].filter(n=>!['retryStartupControls','observeLocalTaskState','startLocalTaskStateRead'].includes(n)||runtimeSource.includes(n+'(')).map(n=>method(runtimeSource,n)).join('\n')+'\n}')(...Object.values(deps))
const sd={PhysicalLocalFiles,withOperationChannel,withSnapshot,readTaskCleanupRecord,readJson,paths,taskLifecycle,z,publishTaskResume,submitTaskCancellation,physicalControlSignalSources}
const Service=new Function(...Object.keys(sd),'return class {\n'+method(serviceSource,'taskControl')+'\n'+method(serviceSource,'stopExecution')+'\n}')(...Object.values(sd))
const js=stripTypeScriptTypes(runtimeSource,{mode:'transform'}),callbackStart=js.indexOf('taskStateObserved: '),callbackBody=callbackStart+'taskStateObserved: '.length,callbackEnd=js.slice(callbackBody).startsWith('async ')?js.indexOf('\n                }',callbackStart)+18:js.indexOf('\n',callbackStart)
assert(callbackStart>=0&&callbackEnd>callbackStart)
const callbackExpression=js.slice(callbackBody,callbackEnd).replace(/,\s*$/,'')
const callback=new Function('PhysicalLocalFiles','return function(task,snapshot,round){return ('+callbackExpression+')(task,snapshot,round)}')(PhysicalLocalFiles)
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
files.updateInExistingDirectory=(p,decide,signal)=>physicalUpdate(p,async bytes=>{const result=await decide(bytes);if(p===holdKey){entered();await holdPromise}return result},signal)
const nativeModes=new Map(),stops=[]
function runtime(){const rt=new Runtime();Object.assign(rt,{files,controls,records:store,roleRecords:new Map(),workOperations:new Map(),pendingTaskStateReads:new Map(),localWakeAdmissions:new Map(),reportedAdmissionDiagnostics:new Set(),pendingControlStops:[],pendingTaskControlDiscovery:new Map(),startupControlsDiscovered:false,closed:false,environment:{heartbeat:async()=>{},changed(){}},retryStartupTasks(){},processObservations:async()=>{},startRestoration(){},processSealedBusiness:async()=>{},startOwnedPump(){},scheduleTaskResume(){},error(e,c){errors.push({message:String(e),context:c})},roleKey:r=>r,organizerWakeWrites:new Map(),cleanupResidues:new Map(),targetedPumps:new Map(),cleaner:{close(){}},loop:{ownsPhysicalTaskCleanup:()=>false,stop:async()=>{}},observations:{dispose:async()=>{}},native:{cancelOpening:async()=>({status:'stopped'})},currentTask:async r=>r.identity.taskId,ownedAsyncContext:f=>f(),safetyCommandFor:()=>undefined,saveRole:async r=>{await store.set('framework-runtime/'+hash(scope)+'/roles/'+hash(r.identity.workId),r);rt.roleRecords.set(r.identity.workId,r)},stopOwnedRecord:async r=>{stops.push(r.identity.executionId);events.push('stop:'+r.identity.executionId);return nativeModes.get(r.identity.executionId)??{status:'stopped'}}});return rt}
const rt=runtime(),updates=[],projection=new FrameworkTaskStateObservation(u=>{updates.push(u);events.push('state:'+u.task.taskId+':'+u.task.control)},e=>errors.push({message:String(e)}),'local');rt.taskStateObservation=projection
const makeRole=(task,execution='execution-'+task,role='Planner')=>({identity:{taskId:task,workId:role+'-'+task,executionId:execution,role},sessionId:'session-'+execution,generation:1})
const discovered=[],wakes=[]
const host=new FrameworkHostLoop(files,tx,store,{member:'A',primary:true,scope,instanceUUID},()=>['A'],{startup:async()=>{},observeLocal:async()=>{},observe:(_,o)=>rt.observe(undefined,o),readRoundStarted:o=>projection.begin(o),taskStateEntries:(e,s,o)=>projection.listed(o,s.revision,e),taskStateObserved:callback.bind(rt),discoverTask:async t=>{discovered.push(t.taskId);events.push('discover:'+t.taskId)},executing:()=>false,wake:async w=>{wakes.push(w);return false},sealBusiness:async()=>{},clean:async()=>false,releaseTask:async()=>{},error:e=>errors.push({message:String(e)})})
const connection={files,scope,transactions:tx,sharedRecords:store,records:store,identity:{instanceUUID},registration:{member:'A'}},svc=new Service();svc.running=new Map([['local',{connection,runtime:rt}]]);svc.withAccessOperation=async(i,f)=>f({connection,commandHostKey:'audit'});svc.controls=()=>controls;svc.beforeLocalTaskUse=async()=>true;svc.access=async()=>({connection});svc.checkScope=()=>{}
const drain=async r=>{for(let n=0;n<20;n++){const pending=[...(r.maintenance?.values()??[])];if(!pending.length)return;await limit(Promise.allSettled(pending),'maintenance');await sleep(0)}throw Error('maintenance did not drain')}

const scenario=process.env.DSS_CONTROL_CASE??'cost2',extra={}
async function prepare(count){
 for(let i=0;i<count;i++)await files.replace('tasks/N'+i+'_P.md','Original independent task '+i)
 await host.poll();await drain(rt)
 const ids=[];for(let i=0;i<count;i++)ids.push(/Task ID: ([a-f0-9-]+)/.exec(await withSnapshot(files,s=>files.read(s,'tasks/N'+i+'_P.md')))[1])
 for(const id of ids)await rt.saveRole(makeRole(id));await host.poll();await drain(rt);return ids
}
function roleTools(role,taskId){
 const registered=new Map(),agent={id:role+'-real-tool',session:{}},ctx={on:()=>()=>{},effect(){},systemPrompt:{section(){}},tools:{register:t=>registered.set(t.name,t)}}
 installFrameworkRoleTools(ctx,agent,{role,taskId,owner:'A',member:'A',workId:role+'-'+taskId,executionId:'tool-'+role+'-'+taskId},{files,notifications:async()=>[],claimNotifications:async()=>({signals:[]}),onError:e=>{throw e},transact:(...args)=>tx.run(...args)})
 let calls=0;return(name,input)=>registered.get(name).execute(input,{agent,callId:'call-'+(++calls),signal:new AbortController().signal,concludeTurn(){events.push('conclude:'+role)}})
}
try{
 if(scenario.startsWith('cost')){
  let ids
  if(scenario==='costfamily'){
   const rootId='80000000-0000-4000-8000-000000000001',middleId='80000000-0000-4000-8000-000000000002',leafId='80000000-0000-4000-8000-000000000003',base={version:1,owner:'A',members:['A'],status:'running'}
   const tasks=[{...base,taskId:rootId,route:'O',sourcePath:'tasks/cost_root_O.md',children:[{taskId:middleId,member:'A',objectiveId:'middle'}]},{...base,taskId:middleId,route:'O',sourcePath:'tasks/cost_middle_O.md',parent:{taskId:rootId,owner:'A',objectiveId:'middle'},children:[{taskId:leafId,member:'A',objectiveId:'leaf'}]},{...base,taskId:leafId,route:'P',sourcePath:'tasks/cost_leaf_P.md',parent:{taskId:middleId,owner:'A',objectiveId:'leaf'}}]
   for(const task of tasks){await files.replace(paths.task(task.taskId),encodeJson(task));await files.replace(task.sourcePath,'Task ID: '+task.taskId+'\nOriginal assigned requirement')}
   await files.replace(paths.inbox(leafId,'A'),'Original accepted leaf work');await host.poll();await drain(rt)
   for(const task of tasks)await rt.saveRole(makeRole(task.taskId,undefined,task.route==='O'?'Organizer':'Planner'));ids=tasks.map(task=>task.taskId);await host.poll();await drain(rt)
  }else ids=await prepare(Number(scenario.slice(4)))
  const displayReads=[],taskStates=controls.taskStates.bind(controls);controls.taskStates=(tasks,...args)=>{displayReads.push(tasks.map(t=>typeof t==='string'?t:t.taskId));return taskStates(tasks,...args)};let roleVisits=0,roleCalls=0;const values=rt.roleRecords.values.bind(rt.roleRecords)
  rt.roleRecords.values=function*(){roleCalls++;for(const value of values()){roleVisits++;yield value}}
  const metadataReads=[],metadataStats=[],read=files.readBytes.bind(files),stat=files.fileMetadata.bind(files)
  files.readBytes=async(s,p)=>{if(/^tasks\/.+\.json$/.test(p))metadataReads.push(p);return read(s,p)}
  files.fileMetadata=async p=>{if(/^tasks\/.+\.json$/.test(p))metadataStats.push(p);return stat(p)}
  listCalls=[];getCalls=[];physicalGetCalls=[];entriesVisited=0;updates.length=0;await host.poll();await drain(rt)
  const observationRoleVisits=roleVisits,observationRoleCalls=roleCalls
  check('Normal Task roles remain unstopped',[...rt.roleRecords.values()].every(record=>!record.stopped),true)
  check('Each idle Task receives exactly one display evaluation per ordinary Host round',displayReads.length,ids.length)
  check('Each idle display evaluation names one distinct Task',new Set(displayReads.flat()).size,ids.length)
  extra.cost={tasks:ids.length,controlPrefixReads:listCalls.filter(k=>k.startsWith(controlRoot)),allPrefixReads:listCalls,technicalMapEntriesVisited:entriesVisited,controlGets:getCalls.filter(k=>k.startsWith(controlRoot)),physicalControlReads:physicalGetCalls.filter(k=>k.endsWith('/control.json')),taskMetadataReads:metadataReads,taskMetadataStats:metadataStats,roleValuesCalls:observationRoleCalls,roleValuesVisited:observationRoleVisits,uiUpdates:updates.length,displayTaskReads:displayReads}
 }else if(scenario==='timer'){
  const[id]=await prepare(1);rt.startupControlsDiscovered=true;const original=rt.roleRecords.get('Planner-'+id),firstCommand='timer-stop-1';let enter,unblock;const entered=new Promise(r=>enter=r),gate=new Promise(r=>unblock=r);const settle=controls.settleExecution.bind(controls),request=controls.requestExecutionStop.bind(controls);let requests=0,drives=0,observes=0
  controls.requestExecutionStop=(...args)=>{requests++;return request(...args)}
  controls.settleExecution=async(...args)=>{if(args[0]===firstCommand){enter();await gate}return settle(...args)}
  const observe=rt.observe.bind(rt);rt.observe=(...args)=>{observes++;return observe(...args)};const drive=host.drive.bind(host);host.drive=(...args)=>{drives++;return drive(...args)}
  await rt.requestExecutionStop(firstCommand,original.identity.workId,original.identity.executionId);await limit(entered,'first exact settlement')
  for(let n=2;n<=3;n++)await rt.requestExecutionStop('timer-stop-'+n,original.identity.workId,original.identity.executionId)
  rt.roleRecords.set(original.identity.workId,{...original,identity:{...original.identity,executionId:'timer-replacement'},generation:2});unblock();await drain(rt)
  check('Later original attempts survive first settlement',rt.pendingControlStops.length,2)
  await host.start();await until(()=>rt.pendingControlStops.length===0,'actual scheduled drive owns remaining exact attempts');await drain(rt)
  check('Real Host timer drive executes without direct runtime.observe calls',drives>=1,true)
  check('Latest original request settles after timer-driven observation',(await controls.execution(original.identity)).result.state,'superseded')
  check('Timer never reissues original stop commands',requests,3)
  check('Only original native execution was stopped',stops,[original.identity.executionId])
  check('All exact attempt responsibilities finish',rt.pendingControlStops,[]);extra.timer={drives,observes,requests}
 }else if(scenario==='busy'){
  const[id]=await prepare(1);let enter,continueBusiness;const entered=new Promise(r=>enter=r),business=new Promise(r=>continueBusiness=r),discover=host.actions.discoverTask;let held=true;host.actions.discoverTask=async(task,...args)=>{if(task.taskId===id&&held){enter();await business}return discover(task,...args)}
  const stateReads=[],taskStates=controls.taskStates.bind(controls);controls.taskStates=(tasks,...args)=>{stateReads.push(tasks.map(t=>typeof t==='string'?t:t.taskId));return taskStates(tasks,...args)}
  await host.drive();await limit(entered,'existing business lane');await drain(rt);updates.length=0
  await svc.taskControl({mode:'local',commandId:'busy-pause',taskId:id,intent:'paused'});getCalls=[];physicalGetCalls=[];stateReads.length=0;await host.drive();if(host.runningFlight)await host.runningFlight.promise;await drain(rt)
  const pause={updates:updates.filter(x=>x.task.taskId===id).map(x=>x.task.control),stateReads:[...stateReads],controlGets:getCalls.filter(k=>k.startsWith(controlRoot)),physicalControlReads:physicalGetCalls.filter(k=>k.endsWith('/control.json'))}
  updates.length=0;stateReads.length=0;await svc.taskControl({mode:'local',commandId:'busy-resume',taskId:id,intent:'running'});stateReads.length=0;getCalls=[];physicalGetCalls=[];await host.drive();if(host.runningFlight)await host.runningFlight.promise;await drain(rt)
  const resume={updates:updates.filter(x=>x.task.taskId===id).map(x=>x.task.control),stateReads:[...stateReads],controlGets:getCalls.filter(k=>k.startsWith(controlRoot)),physicalControlReads:physicalGetCalls.filter(k=>k.endsWith('/control.json'))}
  check('Busy Task lane still publishes pause',pause.updates,['paused']);check('Busy Task lane still publishes resume',resume.updates,['running']);check('Busy lane enqueues only one display read per ordinary round',[pause.stateReads,resume.stateReads],[[[id]],[[id]]])
  extra.busy={pause,resume,taskLaneStillRunning:!!host.taskLanes.get(paths.task(id))?.running}
  check('Control Service pause/resume does not require existing business lane completion',extra.busy.taskLaneStillRunning,true)
  held=false;continueBusiness();await host.poll();await drain(rt);controls.taskStates=taskStates
 }else if(scenario==='states'){
  const state=runtime(),ui=[],stateProjection=new FrameworkTaskStateObservation(update=>ui.push(update),e=>errors.push({message:String(e)}),'local');state.taskStateObservation=stateProjection
  const parent={version:1,taskId:'70000000-0000-4000-8000-000000000001',route:'O',owner:'A',members:['A'],status:'running',sourcePath:'tasks/state_parent_O.md',children:[{taskId:'70000000-0000-4000-8000-000000000002',member:'A',objectiveId:'one'}]},child={version:1,taskId:'70000000-0000-4000-8000-000000000002',route:'P',owner:'A',members:['A'],status:'running',sourcePath:'tasks/state_child_P.md',parent:{taskId:'70000000-0000-4000-8000-000000000001',owner:'A',objectiveId:'one'}},peer={version:1,taskId:'70000000-0000-4000-8000-000000000003',route:'P',owner:'A',members:['A'],status:'running',sourcePath:'tasks/state_peer_P.md'}
  for(const task of [parent,child,peer]){await files.replace(paths.task(task.taskId),encodeJson(task));await files.replace(task.route==='O'?paths.run(task.taskId)+'/Organizer_Note.md':paths.inbox(task.taskId,'A'),'Original Task material')}
  await controls.setTask('parent-held',parent.taskId,'paused')
  const views=[],parentReads=[],snapshot=files.snapshot.bind(files),read=files.readBytes.bind(files)
  files.snapshot=async()=>{const s=await snapshot();views.push({snapshot:s,get released(){return !files.views.has(s)}});return s}
  files.readBytes=async(s,p)=>{if(p===paths.task(parent.taskId))parentReads.push({view:views.find(v=>v.snapshot===s),valid:true});return read(s,p)}
  const queue=async(task)=>{const round={};stateProjection.begin(round);const borrowed=await files.snapshot();await callback.call(state,task,borrowed,round);await borrowed.release();return{round,borrowed}}
  let calls=0;const taskStates=controls.taskStates.bind(controls);controls.taskStates=(...args)=>{calls++;return taskStates(...args)}
  let arrived=hold(controls.taskRecordPath(child.taskId)),write=controls.setTask('child-running-held',child.taskId,'running');await limit(arrived,'child owner put');const old=await queue(child);await until(()=>calls===1,'independent child display read')
  const completed={...child,status:'complete'};await files.replace(paths.task(child.taskId),encodeJson(completed));await queue(completed);await queue(peer);await until(()=>ui.some(x=>x.task.taskId===peer.taskId),'independent peer display')
  check('Peer display finishes while child control read is pending',ui.some(x=>x.task.taskId===peer.taskId),true)
  check('Business borrowed snapshot is released while display owns its own view',views.find(v=>v.snapshot===old.borrowed).released,true)
  check('No old child state is published before held owner resolves',ui.some(x=>x.task.taskId===child.taskId),false)
  release();holdKey=undefined;await write;await drain(state)
  check('Older running result cannot overwrite later accepted complete metadata',ui.filter(x=>x.task.taskId===child.taskId).map(x=>x.task.status),['complete'])
  check('Parent pause is resolved using an independently owned physical view',ui.find(x=>x.task.taskId===child.taskId).task.control,'paused')
  check('Parent metadata never reads the released borrowed business snapshot',parentReads.every(x=>x.view&&x.view.snapshot!==old.borrowed),true)
  check('All display and borrowed snapshots release after completion',views.every(v=>v.released),true)
  check('Completed display responsibility is not kept as a state cache',state.pendingTaskStateReads.size,0)
  // A newer existing Host list can invalidate an old result even without a later task callback.
  const beforeMissing=ui.length;await files.replace(paths.task(child.taskId),encodeJson(child));arrived=hold(controls.taskRecordPath(child.taskId));write=controls.setTask('child-before-cleanup',child.taskId,'running');await arrived;await files.replace(paths.task(child.taskId),encodeJson(completed));await queue(completed);await sleep(0)
  await files.delete(paths.task(child.taskId));const absent={};stateProjection.begin(absent);stateProjection.listed(absent,'existing-host-list',[]);release();holdKey=undefined;await write;await drain(state)
  check('Existing later Task list suppresses display for removed Task',ui.length,beforeMissing)
  // Latest same-ID lifecycle wins, independently of the client's additional lifecycle check.
  await files.replace(paths.task(child.taskId),encodeJson(child));arrived=hold(controls.taskRecordPath(child.taskId));write=controls.setTask('child-old-life',child.taskId,'running');await arrived;await files.replace(paths.task(child.taskId),encodeJson(completed));await queue(completed);await sleep(0)
  const next={...child,parent:undefined,lifecycleId:'new-lifecycle'};await files.replace(paths.task(child.taskId),encodeJson(next));await queue(next);const beforeLife=ui.length;release();holdKey=undefined;await write;await drain(state)
  check('Old lifecycle result never publishes after new lifecycle accepted',ui.slice(beforeLife).map(x=>x.task.lifecycleId),['new-lifecycle'])
  // Existing authoritative view generation still fences an in-flight display result.
  arrived=hold(controls.taskRecordPath(child.taskId));write=controls.setTask('child-new-life-generation',child.taskId,'running','new-lifecycle');await arrived;await queue(next);await sleep(0);const beforeBoundary=ui.length;stateProjection.viewBoundary();release();holdKey=undefined;await write;await drain(state)
  check('Authoritative view generation rejects prior display result',ui.length,beforeBoundary)
  // A failed same input does not become an automatic retry loop; a fresh observation retries.
  let fail=true,attempts=0;controls.taskStates=async(...args)=>{attempts++;if(fail)throw Error('controlled display read failure');return taskStates(...args)};await queue(peer);await drain(state);await sleep(20)
  check('Display read failure has no busy retry',attempts,1);check('Failed same input leaves no persistent display cache',state.pendingTaskStateReads.size,0);fail=false;await queue(peer);await drain(state);check('Next actual observation can retry display read',attempts,2);controls.taskStates=(...args)=>taskStates(...args)
  // Inject a newer observation after the loop deleted its finished input but before its maintenance key is released.
  let gap=true,gapOwned=false,gapTriggered=false;const remove=state.pendingTaskStateReads.delete.bind(state.pendingTaskStateReads),priorUi=ui.length
  state.pendingTaskStateReads.delete=id=>{const value=remove(id);if(gap&&id===peer.taskId){gap=false;queueMicrotask(()=>{gapOwned=state.maintenance.has('task-state:'+id);gapTriggered=true;const newer={};stateProjection.begin(newer);state.observeLocalTaskState({...peer,status:'complete'},'gap-newer',newer)})}return value}
  await queue(peer);await drain(state)
  check('New observation actually arrives while prior maintenance key still owns completion',gapTriggered&&gapOwned,true)
  check('Completion-gap input continues without another Host poll',ui.slice(priorUi).map(x=>x.task.status),['running','complete'])
  check('Completion gap leaves no retained input or maintenance owner',[state.pendingTaskStateReads.size,state.maintenance.size],[0,0])
  // Real dispose waits for the accepted independent view; close suppresses its late UI publication.
  const closing=runtime(),closedUi=[],closingProjection=new FrameworkTaskStateObservation(u=>closedUi.push(u),()=>{},'local');closing.taskStateObservation=closingProjection;const round={};closingProjection.begin(round)
  arrived=hold(controls.taskRecordPath(peer.taskId));write=controls.setTask('peer-before-dispose',peer.taskId,'paused');await arrived;const borrowed=await files.snapshot();await callback.call(closing,peer,borrowed,round);await borrowed.release();await sleep(0)
  let done=false;const disposal=closing.dispose().then(()=>done=true);await sleep(25);check('Dispose owns accepted pending display read',done,false);release();holdKey=undefined;await write;await limit(disposal,'display disposal');await sleep(0)
  check('Close never publishes late display result',closedUi,[]);check('Close clears unfinished display responsibility',closing.pendingTaskStateReads.size,0);check('Close releases its independent view',views.every(v=>v.released),true)
  extra.stateReads={snapshots:views.length,parentReads:parentReads.length,updates:ui.length};controls.taskStates=taskStates
 }else if(scenario==='cleaner'){
  const[id]=await prepare(1);const complete=roleTools('Planner',id),recorder=roleTools('Recorder',id);const cleaner=new FrameworkCleaner(files,tx);let pause,callbackEntered=false,cleanCalls=0,injected=false,pauseSettled=false;let metadataRetired;const retired=new Promise(resolve=>metadataRetired=resolve);const update=files.update.bind(files);files.update=async(p,...args)=>{const result=await update(p,...args);if(p===paths.task(id)&&await withSnapshot(files,s=>files.read(s,p))===undefined)metadataRetired();return result}
  host.actions.clean=async(task,snapshot,observation)=>{cleanCalls++;const result=await cleaner.clean(task,observation);return result.status==='deleted'||result.status==='released'}
  const observe=host.actions.observe,taskObserved=host.actions.taskStateObserved
  host.actions.taskStateObserved=(...args)=>{callbackEntered=true;events.push('taskStateObserved-entry');return taskObserved(...args)}
  host.actions.observe=async(...args)=>{await observe(...args);if(injected)return;injected=true;events.push('prior-runtime-observe-returned');const arrived=hold(controls.taskRecordPath(id));pause=svc.taskControl({mode:'local',commandId:'late-pause',taskId:id,intent:'paused'}).then(value=>{pauseSettled=true;return {value}},error=>{pauseSettled=true;return {error:String(error)}});await limit(arrived,'late pause native put');events.push('late-pause-put-held');const snapshot=await complete('dss_snapshot',{});await complete('dss_complete',{snapshotId:snapshot.snapshotId,acceptance:'Original work accepted',resultPaths:[]});check('Actual dss_complete publishes terminal task',(await withSnapshot(files,s=>readJson(files,s,paths.task(id)))).status,'complete');const view=await recorder('dss_snapshot',{});const saved=await recorder('dss_recorder_save',{snapshotId:view.snapshotId,outputs:[{path:view.archiveRecordsPath,text:'Actual final record'}],retainedPaths:[]});check('Actual Recorder save succeeds',saved.saved,true);check('Actual Recorder publishes Cleaner',await withSnapshot(files,s=>files.read(s,paths.state('A',id)+'/Cleaner')),'');events.push('real-recorder-cleaner-published')}
  const poll=host.poll();await until(()=>callbackEntered,'post-pause display callback enters');await limit(retired,'Host metadata retirement while owner write held')
  const before={cleanCalls,taskExists:await withSnapshot(files,async s=>(await files.read(s,paths.task(id)))!==undefined),events:[...events]};extra.cleanerBeforeOwnerWriteReturned=before
  check('Independent display read never becomes a Cleaner prerequisite',before.cleanCalls,1);check('Actual Cleaner removes metadata before late owner write returns',before.taskExists,false);check('Original pause remains held at Host metadata retirement',pauseSettled,false)
  release();holdKey=undefined;await limit(Promise.all([pause,poll]),'late pause and Cleaner');await drain(rt)
  if(!cleanCalls)process.stderr.write(JSON.stringify({errors,events,before,wakes},null,2)+'\n')
  check('Cleaner executed independently before original write finished',cleanCalls>0,true)
  check('Deleted Task causes explicit original pause failure, not fake acknowledgement',(await pause).error?.includes('directory no longer exists'),true)
  check('Original pause cannot recreate removed Task root',await files.entryInfo(paths.run(id)),undefined)
  check('Task metadata eventually retires',await withSnapshot(files,s=>files.read(s,paths.task(id))),undefined)
 }
 console.log(JSON.stringify({status:'completed',scenario,checks,...extra,events,errors,...evidence(),limits:'Actual Host poll/drive, production runtime control methods, Service controls, SDK JSON store and physical files. Native stop and unrelated runtime observation subsystems retain the explicitly declared ports from validate-local-control-observation; cost is a full Host ordinary control/display round, not all role models or every background subsystem. Cleaner scenario executes actual registered dss_complete and dss_recorder_save with native tool registration captured; FrameworkCleaner and Host cleanup run unchanged, while final native release is a no-op boundary. Markdown parser is a declared no-link fixture port that rejects link-bearing text; no skill outputs or native model are exercised.'},null,2))
}finally{release?.();holdKey=undefined;rt.closed=true;await host.stop();await drain(rt);await files.close();await fixture.close();JsonStorageBackend.prototype.openUnit=nativeOpen;supplemental.deregister();hooks.deregister();await fs.rm(root,{recursive:true,force:true})}
