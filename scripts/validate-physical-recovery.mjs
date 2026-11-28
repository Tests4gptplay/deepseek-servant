import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
// Actual dss_snapshot/dss_record installation and physical files. Schema parsing
// and unrelated Markdown/skill dependencies are explicit stubs. No native DSH,
// Windows, full typecheck or production cutover is asserted by this script.
const sourceRoot=new URL('../src/',import.meta.url),loaded=new Map()
const data=text=>'data:text/javascript;base64,'+Buffer.from(text).toString('base64')
const hooks=registerHooks({resolve(specifier,context,next){
 if(specifier==='zod')return{url:data(`const z=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;if(k==='toJSONSchema')return ()=>({});return z},apply(){return z}});export {z}`),shortCircuit:true}
 if(specifier==='mdast-util-from-markdown')return{url:data(`export function fromMarkdown(){throw new Error('Markdown outside this test')}`),shortCircuit:true}
 if(specifier.startsWith('.')&&context.parentURL?.startsWith(sourceRoot.href)&&specifier.endsWith('.js')){
 const url=new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
 if(url.href===new URL('framework/skills.ts',sourceRoot).href)return{url:data(`export const frameworkSkillIndexPath='skills/index.md';export function isFrameworkSkillDefinitionPath(){throw new Error('Skill definition outside this test')}export function prepareFrameworkSkillIndex(){throw new Error('Skills outside this test')}`),shortCircuit:true}
 if(existsSync(fileURLToPath(url)))return{url:url.href,shortCircuit:true}}
 return next(specifier,context)},load(url,context,next){if(url.startsWith(sourceRoot.href)&&url.endsWith('.ts')){const source=readFileSync(new URL(url),'utf8');loaded.set(url.slice(sourceRoot.href.length),createHash('sha256').update(source).digest('hex'));return{format:'module',source:stripTypeScriptTypes(source,{mode:'transform',sourceUrl:url}),shortCircuit:true}}return next(url,context)}})
const { PhysicalLocalFiles }=await import('../src/framework/physical-local-files.ts')
const { installFrameworkRoleTools,workerPaths,parseDirectSignal,signalWorkerId }=await import('../src/framework/role-tools.ts')
const { paths,readJson,encodeJson,assertTaskLifecycle,taskLifecycleKey,readMemberStatus }=await import('../src/framework/task-files.ts')
const { TaskWorkspaces }=await import('../src/framework/task-workspace.ts')
let assertions=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++};const rejects=async(f,re)=>{await assert.rejects(f,re);assertions++}
const root=await fs.mkdtemp(path.join(os.tmpdir(),'dss-role-records-')),files=new PhysicalLocalFiles(root)
const read=async p=>{const s=await files.snapshot();try{return await files.read(s,p)}finally{await s.release()}}
const task={version:1,taskId:'10000000-0000-4000-8000-000000000001',route:'P',owner:'A',members:['A'],status:'running',sourcePath:'tasks/a.md'}
await files.replace(paths.task(task.taskId),JSON.stringify(task));await files.replace(task.sourcePath,'Original requirement')
let calls=0
function role(roleName,extra={},services={}){
 const tools=new Map(),agent={id:'agent-'+roleName,session:{}},ctx={on:()=>()=>{},effect:()=>{},systemPrompt:{section(){}},tools:{register:t=>tools.set(t.name,t)}}
 const binding={role:roleName,taskId:task.taskId,owner:'A',member:'A',workId:'work-'+roleName,executionId:'execution-'+roleName,...extra}
 installFrameworkRoleTools(ctx,agent,binding,{files,transact:async()=>{throw new Error('Unexpected generic transaction')},notifications:async()=>[],claimNotifications:async()=>({signals:[]}),onError:()=>{},...services})
 let ended=0
 return {get ended(){return ended},call:(name,input,signal=new AbortController().signal)=>tools.get(name).execute(input,{agent,callId:'call-'+(++calls),signal,concludeTurn:()=>ended++}),binding}
}
const {publishPhysicalRecovery,consumePhysicalRecovery,retirePublishedPhysicalRecovery}=await import('../src/framework/physical-recovery.ts')
const {withSnapshot,FilesOutcomeUnknownError,GitFiles}=await import('../src/framework/transactions.ts')
const {GitAuthorityStore,listAuthorityInRound}=await import('../src/framework/git-authority.ts')
const {readTaskCleanupRecord}=await import('../src/framework/cleaner.ts')
const {createRecoveryWatch,dueRecoveryWatch}=await import('../src/framework/recovery.ts')
const {FrameworkTaskIndex}=await import('../src/framework/task-index.ts')
const {taskLifecycle}=await import('../src/framework/task-files.ts')
const source=readFileSync(new URL('framework/role-runtime.ts',sourceRoot),'utf8')
function method(name){const start=source.indexOf(name);assert(start>=0,name);const next=source.slice(start+name.length).search(/\n  (?:private |async |[A-Za-z]+\()/);assert(next>=0,name);return source.slice(start,start+name.length+next)}
const names=['  private async retirePhysicalRestoreDebug(', '  private roleKey(', '  private async physicalSignalSources(', '  private addressedSignals(', '  private consumeWakeSignals(', '  private taskNoticeConsumption(', '  private assertOrganizerBusiness(', '  private watchKey(', '  private async serialRecoveryWatch', '  private async consumeRecoveryMarker(', '  private async recoveryWatchChanges(', '  private async observeRecoveryMarkers(', '  private async publishPhysicalMemberRecovery(', '  private async publishPhysicalOwnerRecovery(', '  private async recordRestoreDebug(', '  private async ownerRecoveryChanges(', '  private async publishOwnerRecovery(', '  private recoveryInputPath(', '  private async publishPhysicalHostRestoration(', '  private scheduleHostRestoreRetirement(', '  private considerHostRestoreRetirement(', '  private async processHostRestores(', '  private async updateSafetyRestoreRow', '  private restoreTaskOwner(']
const { hostRecoveryDebugPath, hostRecoverySignalPath }=await import('../src/framework/recovery-debug-record.ts')
const deps={GitFiles,hostRecoveryDebugPath,hostRecoverySignalPath,hash:t=>createHash('sha256').update(t).digest('hex'),PhysicalLocalFiles,GitAuthorityStore,withSnapshot,paths,readJson,encodeJson,assertTaskLifecycle,taskLifecycleKey,readMemberStatus,readTaskCleanupRecord,createRecoveryWatch,dueRecoveryWatch,publishPhysicalRecovery,retirePublishedPhysicalRecovery,listAuthorityInRound,FilesOutcomeUnknownError,taskLifecycle,parseDirectSignal,signalWorkerId}
const Runtime=new Function(...Object.keys(deps),stripTypeScriptTypes('class Runtime {\n'+names.map(method).join('\n')+'\n}',{mode:'transform'})+'\nreturn Runtime')(...Object.values(deps))
const values=new Map(),records={async get(k){return structuredClone(values.get(k))},async set(k,v){values.set(k,structuredClone(v))},async list(prefix){return [...values].filter(([k])=>k.startsWith(prefix)).map(([key,value])=>({key,value:structuredClone(value)}))}}
const runtime=new Runtime();Object.assign(runtime,{files,records,prefix:'recovery/',config:{member:'A'},closed:false,transactions:{run(){throw Error('Generic transaction reached')}},taskRuntimeReleased:async()=>false,manuallyCleared:async()=>false,currentTask:async record=>record.identity.taskId,pending:[],native:new Map(),roleRecords:new Map(),wakeConsumptions:new Map()});runtime.wake=async q=>runtime.pending.push(q)
const marker=paths.state('A',task.taskId)+'/recovery',note=paths.member(task.taskId,'A')+'/Planner_Memory.md'
const nativeNow=Date.now;let time=1_000;Date.now=()=>time
let interruptions=0
try{
 await files.replace(paths.inbox(task.taskId,'A'),'original Inbox');await files.replace(note,'original Memory\n')
 const planner=role('Planner',{}, {consumeRecovery:(binding,consume)=>runtime.consumeRecoveryMarker(binding,consume)})
 const view=await planner.call('dss_snapshot',{})
 await runtime.publishPhysicalMemberRecovery('startup-member-recovery:actual',{taskId:task.taskId,member:'A'})
 check(await read(marker),'');await runtime.observeRecoveryMarkers(undefined,[task]);const key=runtime.watchKey(task.taskId,'A')
 check((await records.get(key)).watch.cycleStartedAt,1_000)
 time+=29*60_000;await planner.call('dss_recovery_consume',{snapshotId:view.snapshotId,continuation:'confirmed continuation\n'})
 check(await read(marker),undefined);check((await records.get(key)).watch,undefined);check(await read(note),'original Memory\nconfirmed continuation\n')
 // Another real publication occurs before any poll observes the missing marker.
 await runtime.publishPhysicalMemberRecovery('startup-member-recovery:next',{taskId:task.taskId,member:'A'})
 await runtime.observeRecoveryMarkers(undefined,[task]);const restarted=time;check((await records.get(key)).watch.cycleStartedAt,restarted)
 time+=2*60_000;await runtime.observeRecoveryMarkers(undefined,[task]);check(runtime.pending.length,0)
 time=restarted+30*60_000;await runtime.observeRecoveryMarkers(undefined,[task]);check(runtime.pending.length,1)
 // Exact physical identity detects consume/recreation even if a process exited
 // after marker deletion but before the Host watch reset became durable.
 await files.delete(marker);await files.replace(marker,'');time+=1_000
 await runtime.observeRecoveryMarkers(undefined,[task]);check((await records.get(key)).watch.cycleStartedAt,time);check((await records.get(key)).watch.stage,0)
 await files.delete(marker);await runtime.observeRecoveryMarkers(undefined,[task]);check((await records.get(key)).watch,undefined)
 const signal=paths.state('A',task.taskId)+'/Planner_Recovery_2026-11-08_actual'
 const observedDebug=hostRecoveryDebugPath('debug/2026-11-08.md','observation-recovery:actual'),observedSignal=hostRecoverySignalPath(signal,observedDebug)
 await runtime.publishPhysicalMemberRecovery('observation-recovery:actual',{taskId:task.taskId,member:'A'},{path:'debug/2026-11-08.md',text:'observed interruption\n'},signal)
 check(await read(observedSignal),'');check(await read(observedDebug),'observed interruption\n');check(await read('debug/2026-11-08.md'),undefined)
 const originalVersion=(await files.fileInfo(marker)).version
 await runtime.publishPhysicalMemberRecovery('another-current-recovery',{taskId:task.taskId,member:'A'})
 check((await files.fileInfo(marker)).version,originalVersion)
 await files.delete(marker);await files.delete(observedSignal)
 await runtime.publishPhysicalMemberRecovery('observation-recovery:actual',{taskId:task.taskId,member:'A'},{path:'debug/2026-11-08.md',text:'observed interruption\n'},signal)
 check(await read(marker),undefined);check(await read(observedSignal),undefined)
 await files.replace(paths.memberStatus(task.taskId,'A'),JSON.stringify({state:'complete'}))
 await runtime.publishPhysicalMemberRecovery('completed-member',{taskId:task.taskId,member:'A'});check(await read(marker),undefined)
 await runtime.publishOwnerRecovery('recorder-recovery',{identity:{role:'Recorder',taskId:task.taskId}});check(await read(marker),'')
 const restore={key:'restore/actual',value:{commandId:'restore-actual',createdAt:'2026-11-08T10:00:00Z',input:{facts:'original facts',continuation:'original input'}}}
 await runtime.recordRestoreDebug(restore);await runtime.recordRestoreDebug(restore)
 check((await read(hostRecoveryDebugPath('debug/2026-11-08.md','restore-debug:restore-actual'))).split('original facts').length-1,1)
 await rejects(()=>runtime.consumeRecoveryMarker({...planner.binding,role:'Worker'},async()=>true),/Only the bound member Planner/)
 const worker=role('Worker',{workerId:'w'},{workerBusiness:{assertLive(){},async assert(){}}})
 // The tool is not installed for Worker at all, rather than demanding per-Worker ACK.
 await rejects(async()=>worker.call('dss_recovery_consume',{snapshotId:view.snapshotId,continuation:'invalid'}),/undefined/)

 // Actual overall Host restoration retains its original eligible managers,
 // saves original diagnostics, then publishes each role's existing empty signal.
 await files.replace(paths.memberStatus(task.taskId,'A'),JSON.stringify({state:'running'}))
 const organizerTask={...task,taskId:'10000000-0000-4000-8000-000000000003',route:'O',sourcePath:'tasks/o.md'}
 await files.replace(paths.task(organizerTask.taskId),JSON.stringify(organizerTask))
 runtime.safetyRestoreWrites=new Map();runtime.environment={};runtime.replaySafetyRestore=()=>{};runtime.safetyRestoreSettled=async()=>{}
 runtime.taskMetadata=snapshot=>new FrameworkTaskIndex(files,e=>{throw e}).list(snapshot)
 const hostRow={key:'recovery/host-restores/actual',value:{commandId:'overall-actual',createdAt:'2026-11-08T12:00:00Z',input:{facts:'original overall facts',hypotheses:'original hypothesis',actionsTaken:'preserved originals',continuation:'resume exact work'},complete:false,targets:[]}}
 await records.set(hostRow.key,hostRow.value)
 await runtime.processHostRestores()
 const settled=await records.get(hostRow.key);check(settled.complete,true);check(settled.managerPublications.length,2)
 for(const item of settled.managerPublications){
  const notice=paths.state(item.member,item.taskId)+'/'+item.role+'_Helper'
  check(await read(notice),'')
  check(JSON.parse(await read(runtime.recoveryInputPath(item.taskId,item.member,item.role))),{...hostRow.value.input,at:hostRow.value.createdAt,debugPath:hostRecoveryDebugPath('debug/2026-11-08.md','host-restore-debug:overall-actual')})
  await files.delete(notice)
 }
 // Retry the accepted publication with original input does not recreate a
 // manager notification already consumed, and does not append another debug.
 await runtime.publishPhysicalHostRestoration({key:hostRow.key,value:settled})
 check((await read(hostRecoveryDebugPath('debug/2026-11-08.md','host-restore-debug:overall-actual'))).split('original overall facts').length-1,1)
 for(const item of settled.managerPublications)check(await read(paths.state(item.member,item.taskId)+'/'+item.role+'_Helper'),undefined)
 // Real Git transaction + routed watch stores: identical empty marker bytes
 // still form a new watch when the bound Planner consumed the prior marker.
 const {SessionGitOperations}=await import('../src/framework/git-authority.ts')
 const {FrameworkTransactions}=await import('../src/framework/command-transactions.ts')
 const {Repository,put,head}=await import('./test-support/controlled-git/repository.mjs')
 const repo=new Repository(),gitFiles=new GitFiles(repo,new SessionGitOperations()),gitRecords=new GitAuthorityStore(gitFiles,'recovery-test')
 const git=new Runtime();Object.assign(git,{...runtime,files:gitFiles,records:gitRecords,pending:[],recoveryWatchWrites:undefined})
 git.wake=async q=>git.pending.push(q)
 const commands=new FrameworkTransactions(gitFiles,gitRecords,'recovery-test')
 put(repo,paths.task(task.taskId),task);put(repo,marker,'');head(repo)
 await git.observeRecoveryMarkers(undefined,[task]);time+=29*60_000
 const gitPlanner=role('Planner',{}, {files:gitFiles,transact:(...args)=>commands.run(...args),consumeRecovery:(binding,consume)=>git.consumeRecoveryMarker(binding,consume),recoveryWatchChanges:(binding,snapshot)=>git.recoveryWatchChanges(binding,snapshot)})
 const gitView=await gitPlanner.call('dss_snapshot',{})
 await gitPlanner.call('dss_recovery_consume',{snapshotId:gitView.snapshotId,continuation:'Git confirmed normal continuation'})
 check(await withSnapshot(gitFiles,s=>gitFiles.read(s,note)),'Git confirmed normal continuation')
 check((await gitRecords.get(git.watchKey(task.taskId,'A'))).watch,undefined)
 put(repo,marker,'');head(repo);await git.observeRecoveryMarkers(undefined,[task]);const gitStart=time
 time+=2*60_000;await git.observeRecoveryMarkers(undefined,[task]);check(git.pending.length,0)
 check((await gitRecords.get(git.watchKey(task.taskId,'A'))).watch.cycleStartedAt,gitStart)
 await commands.run('git-marker-absent',{}, {},async()=>[{path:marker,content:null}]);await git.observeRecoveryMarkers(undefined,[task])
 check((await gitRecords.get(git.watchKey(task.taskId,'A'))).watch,undefined)
 async function fixture(name){const f=new PhysicalLocalFiles(path.join(root,name));await f.replace(paths.task(task.taskId),JSON.stringify(task));await f.replace(note,'original Memory\n');await f.replace('debug/2026-11-08.md','original debug\n');return f}
 const input={commandId:'exact-recovery',taskId:task.taskId,markerPath:marker,debug:{path:'debug/2026-11-08.md',text:'original recovery input\n'},signalPath:signal,recoveryInput:{path:'technical/recovery-inputs/'+task.taskId+'/A/Planner.json',text:'original diagnostic input'}}
 const readAt=(f,p)=>withSnapshot(f,s=>f.read(s,p))
 for(const kind of ['publish','consume']){
  let f=await fixture('trace-'+kind),trace=[]
  if(kind==='consume')await f.replace(marker,'')
  const consumption={commandId:'exact-consume',taskId:task.taskId,member:'A',continuation:'confirmed\n'}
  let receiptRuntime
  const action=x=>kind==='publish'?publishPhysicalRecovery(x,input,()=>{},p=>receiptRuntime?.physicalSignalSources(p)??Promise.resolve([])):consumePhysicalRecovery(x,consumption,()=>{})
  for(const name of ['replace','rename','deleteObserved','appendPrepared']){const actual=f[name].bind(f);f[name]=async(...args)=>{trace.push([name,...args]);return actual(...args)}}
  await action(f);await f.close()
  for(const when of ['before','after'])for(let stop=0;stop<trace.length;stop++){
   receiptRuntime=undefined
   f=await fixture(kind+'-'+when+'-'+stop);if(kind==='consume')await f.replace(marker,'')
   let step=0,published=false,consumed=false,hit=false
   for(const name of ['replace','rename','deleteObserved','appendPrepared']){const actual=f[name].bind(f);f[name]=async(...args)=>{
    const ordinal=step++;if(ordinal===stop&&when==='before'){hit=true;throw Error('actual interruption')}
    const result=await actual(...args);if(name==='rename'&&args[1]===signal&&result)published=true;if(name==='deleteObserved'&&args[0]===marker&&result)consumed=true
    if(ordinal===stop&&when==='after'){hit=true;throw Error('actual interruption')}return result
   }}
   await rejects(()=>action(f),/actual interruption/);check(hit,true);interruptions++
   // Existing accepted RoleRecord sources plus actual runtime consumption,
   // not a fabricated receipt or absence-as-success. Native admission is controlled.
   if(published){
    receiptRuntime=new Runtime();Object.assign(receiptRuntime,{...runtime,files:f,roleRecords:new Map(),wakeConsumptions:new Map()})
    const workId=receiptRuntime.roleKey('Planner',task.taskId),binding={role:'Planner',workId,executionId:'receiver',taskId:task.taskId,member:'A'}
    const observed=await f.fileInfo(signal),record={identity:binding,lastWake:{id:'accepted-'+stop,sources:[{path:signal,version:observed.version}]}}
    receiptRuntime.roleRecords.set(workId,record);await records.set(runtime.prefix+'roles/'+deps.hash(workId),record)
    await receiptRuntime.consumeWakeSignals(binding)
    // Marker ownership remains Planner's continuation action.
    const clean=new PhysicalLocalFiles(f.directory);await consumePhysicalRecovery(clean,{...consumption,commandId:'receiver-'+when+'-'+stop},()=>{});await clean.close()
   }
   if(consumed)await fs.writeFile(path.join(f.directory,marker),'')
   const dir=f.directory;await f.close();f=new PhysicalLocalFiles(dir)
   if(receiptRuntime)receiptRuntime.files=f
   await action(f)
   if(kind==='publish'){
    check(await readAt(f,'debug/2026-11-08.md'),'original debug\noriginal recovery input\n')
    check(await readAt(f,input.recoveryInput.path),'original diagnostic input')
    check(await readAt(f,signal),published?undefined:'');check(await readAt(f,marker),published?undefined:'')
   }else{check(await readAt(f,note),'original Memory\nconfirmed\n');check(await readAt(f,marker),consumed?'':undefined)}
   await f.close()
  }
 }
 console.log(JSON.stringify({status:'passed',assertions,interruptedOperations:interruptions,limits:'Real physical recovery module, installed Planner tool, actual Host marker/watch/debug method bodies, cold file-backed reconstructions. Controlled technical records/native role ports; not full typecheck, OS crash durability, native DSH, Windows, migration or cutover acceptance.',sourceHashes:{...Object.fromEntries(loaded),'framework/role-runtime.ts':createHash('sha256').update(source).digest('hex')}},null,2))
}finally{Date.now=nativeNow;await files.close();await fs.rm(root,{recursive:true,force:true});hooks.deregister()}
