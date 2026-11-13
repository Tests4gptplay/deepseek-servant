import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
// Actual runtime method bodies and Host signal discovery; native session completion
// and technical persistence are explicit ports, not a desktop acceptance run.
// Preselected fault/recovery inputs and the deliberate deletion failure are
// controlled contract fixtures, not evidence of naturally occurring failures.
const sourceRoot = new URL('../src/', import.meta.url), loaded = new Map()
const data = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'zod') return { url: data(`const z=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;if(k==='toJSONSchema')return ()=>({});return z},apply(){return z}});export {z}`), shortCircuit: true }
  if (specifier === 'mdast-util-from-markdown') return { url: data(`export function fromMarkdown(){throw new Error('Markdown outside this test')}`), shortCircuit: true }
  if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
    const url = new URL(specifier.slice(0,-3) + '.ts', context.parentURL)
    if (url.href === new URL('framework/skills.ts',sourceRoot).href) return { url: data(`export const frameworkSkillIndexPath='skills/index.md';export function isFrameworkSkillDefinitionPath(){throw new Error('Skill definition outside this test')}export function prepareFrameworkSkillIndex(){throw new Error('Skills outside this test')}`), shortCircuit: true }
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
  }
  return next(specifier, context)
}, load(url,context,next) {
  if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
    const source = readFileSync(new URL(url),'utf8'); loaded.set(url.slice(sourceRoot.href.length),createHash('sha256').update(source).digest('hex'))
    return { format:'module',source:stripTypeScriptTypes(source,{mode:'transform',sourceUrl:url}),shortCircuit:true }
  }
  return next(url,context)
} })
const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {helperDebugPath}=await import('../src/framework/helper-debug-path.ts')
const {FrameworkHostLoop,helperSignalWakeHash}=await import('../src/framework/host-loop.ts')
const {withSnapshot,withOperationChannel,GitFiles}=await import('../src/framework/transactions.ts')
const {GitAuthorityStore,listAuthorityInRound,SessionGitOperations}=await import('../src/framework/git-authority.ts')
const {paths,readJson,readMemberStatus,assertTaskLifecycle,taskLifecycleKey,taskLifecycle}=await import('../src/framework/task-files.ts')
const {readTaskCleanupRecord}=await import('../src/framework/cleaner.ts')
const {createRecoveryWatch,dueRecoveryWatch}=await import('../src/framework/recovery.ts')
const {Repository,put,head}=await import('./test-support/controlled-git/repository.mjs')
const {FrameworkTransactions}=await import('../src/framework/command-transactions.ts')
const {parseDirectSignal,signalWorkerId,installFrameworkRoleTools}=await import('../src/framework/role-tools.ts')
const {localForegroundRoleRecordPath}=await import('../src/framework/conversation.ts')
const {randomUUID}=await import('node:crypto')
const source=readFileSync(new URL('framework/role-runtime.ts',sourceRoot),'utf8')
function method(name){const start=source.indexOf(name);assert(start>=0,name);const next=source.slice(start+name.length).search(/\n  (?:private |async |[A-Za-z]+\()/);assert(next>=0,name);return source.slice(start,start+name.length+next)}
const names=['  private roleKey(', '  private roleRecordPath(', '  private physicalDirectInput(', '  async wake(', '  private async storeWake(', '  private continueSettledHelperWakeRetirement(', '  private scheduleHelperSignal(', '  private async publishHelperSignal(', '  private wakeAdmission(', '  private updateWake(', '  private rememberAdmissionWake(', '  private forgetAdmissionWake(', '  private addressedSignals(', '  private consumeWakeSignals(', '  private taskNoticeConsumption(', '  private watchKey(', '  private async serialRecoveryWatch', '  private async observeRecoveryMarkers(', '  private async resetRecoveryCheck(', '  private scheduleHostRestoreRetirement(', '  private scheduleCompletedHostRestoreRetirement(', '  private async finishGitAuxiliaryRound(', '  private async retrySettledHelperWakeRetirement(', '  private async retireSettledHelperWakes(', '  private admissionWakes(', '  private startTargetedAdmission(', '  private runQueue(', '  private async runQueueInChannel(', '  private async settleOperations(', '  async notifications(', '  private claimCurrentNotifications(', '  private withRoleWrite', '  private async settleNotificationClaim(', '  private helperResponsibilities(', '  private forgetForegroundNotices(', '  private binding(', '  private safetyFaultFromWake(', '  private replaySafetyWake(', '  private safetyFaultIds(', '  private async recordSafetyAttempt(']
class DshSessionReader{constructor(ctx){this.ctx=ctx}async capture(){return this.ctx.nativeCapture}async events(){return this.ctx.events??[]}}
const {retirePhysicalPublicationsFromEvents}=await import('../src/framework/physical-publication-retirement.ts')
const deps={helperDebugPath,GitFiles,localForegroundRoleRecordPath,DshStorageAdapter: class ControlledNonDshStorageAdapter {},retirePhysicalPublicationsFromEvents,hash:t=>createHash('sha256').update(t).digest('hex'),randomUUID,PhysicalLocalFiles,GitAuthorityStore,helperSignalWakeHash,withSnapshot,withOperationChannel,paths,readJson,readMemberStatus,taskLifecycleKey,assertTaskLifecycle,readTaskCleanupRecord,createRecoveryWatch,dueRecoveryWatch,parseDirectSignal,signalWorkerId,taskLifecycle,DshSessionReader,listAuthorityInRound}
const Runtime=new Function(...Object.keys(deps),stripTypeScriptTypes('class Runtime {\n'+names.map(method).join('\n')+'\n}',{mode:'transform'})+'\nreturn Runtime')(...Object.values(deps))
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'dss-helper-')),files=new PhysicalLocalFiles(scratch)
let assertions=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++},hash=deps.hash
const state=new Map(),clone=v=>v===undefined?undefined:structuredClone(v)
const records={async get(k){return clone(state.get(k))},async set(k,v){state.set(k,clone(v))},async list(prefix){return[...state].filter(([k])=>k.startsWith(prefix)).map(([key,value])=>({key,value:clone(value)}))}}
const runtime=()=>{const r=new Runtime();Object.assign(r,{config:{member:'A',mode:'local'},files,records,prefix:'runtime/',closed:false,helperWakeWrites:new Map(),wakeWrites:new Map(),wakeWriteOwners:new Map(),roleRecords:new Map(),targetedPumps:new Map(),localWakeAdmissions:new Map(),reportedAdmissionDiagnostics:new Set(),admissionObservationVersion:0,publishedHelperSignals:new Set(),wakeConsumptions:new Map(),tasks:[],pending:[],admitted:[],ctx:{nativeCapture:{finished:false}},transactions:{run(){throw Error('Generic transaction reached')},committedReceipt(){throw Error('Physical receipt reached')}}});r.taskRuntimeReleased=async()=>false;r.taskCommandOwner=()=>undefined;r.assertOrganizerBusiness=()=>{};r.requestKey=q=>q.role;r.startMaintenance=(_k,fn)=>r.pending.push(Promise.resolve().then(fn));r.error=e=>{throw e};r.manuallyCleared=async()=>false;r.active=()=>false;r.saveRole=async v=>r.roleRecords.set(v.identity.workId,clone(v));r.replaySafetyWakes=()=>{};r.waitingSafetyResolution=()=>false;r.transferredWorkerWake=()=>false;r.serialWork=async(k,_fn)=>{r.admitted.push(k)};return r}
const drain=async r=>{while(r.pending.length||r.targetedPumps.size)await Promise.all([...r.pending.splice(0),...r.targetedPumps.values()])}
const rows=()=>records.list('runtime/wakes/')
const read=p=>withSnapshot(files,s=>files.read(s,p))
async function poll(r,active=false){const host=new FrameworkHostLoop(r.files,{},r.records,{member:'A',primary:false,scope:'test',instanceUUID:'10000000-0000-4000-8000-000000000002'},()=>['A'],{executing:()=>active,wake:q=>r.wake(q),error:e=>{throw e}});await Promise.all(await host.runSignalPoll());await drain(r)}
async function owner(r,wake){const v={identity:{role:'Helper',workId:'Helper',executionId:randomUUID(),member:'A'},sessionId:'controlled-session',lastWake:clone(wake.request)};r.roleRecords.set('Helper',v);await r.updateWake('runtime/wakes/'+hash(wake.request.id),x=>({...x,delivered:true}));return v}

const originalNow=Date.now;let time=10_000;Date.now=()=>time
function toolsFor(r,record){
 const registered=new Map(),agent={id:record.identity.executionId,session:{}},binding={...r.binding(record,record.lastWake),owner:'A'}
 const ctx={on:()=>()=>{},effect(){},systemPrompt:{section(){}},tools:{register:t=>registered.set(t.name,t)}}
 installFrameworkRoleTools(ctx,agent,binding,{files:r.files,transact:(...args)=>r.transactions.run(...args),notifications:(s,b,id)=>r.notifications(s,b,id),
 claimNotifications:(b,id)=>r.claimCurrentNotifications(b,id),onError(){},
 observation:{reset:(binding,input,_commandId,signal)=>r.resetRecoveryCheck(binding,input.recoveryCheckId,signal)},
 helper:{notifications:b=>r.helperResponsibilities(r.roleRecords.get(b.workId)),faults:()=>[]}})
 return{binding,async call(id,name,input={}){r.ctx.events??=[];r.ctx.events.push({type:'tool/call',data:{callId:id,name,arguments:JSON.stringify(input)}})
  try{const result=await registered.get(name).execute(input,{agent,callId:id,signal:new AbortController().signal,concludeTurn(){}});r.ctx.events.push({type:'tool/result',data:{message:{toolCallId:id,isError:false,content:registered.get(name).output.render(input,result)}}});return result}
  catch(error){r.ctx.events.push({type:'tool/result',data:{message:{toolCallId:id,isError:true}}});throw error}
 }}}
async function scenario(mode){
 const r=runtime();r.config.mode=mode;r.safetyEpisodes=new Map();r.resolvedSafetyFaultIds=new Set();r.safetyReplayed=new Set();r.environment={};r.ctx.events=[]
 if(mode==='local')r.files=new PhysicalLocalFiles(path.join(scratch,mode))
 else{r.files=new GitFiles(new Repository(),new SessionGitOperations());r.records=new GitAuthorityStore(r.files,'active-helper');r.transactions=new FrameworkTransactions(r.files,r.records,'active-helper')}
 const key='runtime/roles/'+hash('Helper')
 r.saveRole=async value=>{r.roleRecords.set('Helper',clone(value));if(r.records instanceof GitAuthorityStore)await r.records.updateOwned(key,'fixture-save:'+randomUUID(),()=>({value,result:undefined,write:true}));else await r.records.set(key,value)}
 const write=async(p,text)=>{if(r.files instanceof PhysicalLocalFiles)await r.files.replace(p,text);else await withSnapshot(r.files,s=>r.files.commit(s,[{path:p,content:text}],'fixture '+randomUUID()))}
 const read=p=>withSnapshot(r.files,s=>r.files.read(s,p))
 const initial={id:mode+'-initial',role:'Helper',reason:'helper',sources:[],context:{facts:'original Helper responsibility'}}
 await r.wake(initial);await drain(r);await poll(r)
 let first=await r.records.get('runtime/wakes/'+hash(initial.id)),record=await owner(r,first);await r.saveRole(record)
 let api=toolsFor(r,record);await api.call('initial-claim','dss_claim')
 const requests=[]
 for(let i=1;i<=3;i++){
  const taskId='10000000-0000-4000-8000-00000000000'+i,cycleStartedAt=time-i*1000,marker='state/A/'+taskId+'/recovery'
  await write(paths.task(taskId),JSON.stringify({version:1,taskId,owner:'A',route:'P',status:'running',sourcePath:'tasks/'+i+'.md'}));await write(marker,'')
  const request={id:mode+'-check-'+i,role:'Helper',taskId,reason:'observation',sources:[{path:marker,version:'original-marker-observation'}],context:{observation:{kind:'recovery-check',taskId,member:'A',cycleStartedAt,stage:1}}}
  await r.records.set(r.watchKey(taskId,'A'),{taskId,member:'A',watch:{taskId,member:'A',cycleStartedAt,stageStartedAt:cycleStartedAt,stage:1}})
  requests.push(request)
  if(i<3){await r.wake(request);await drain(r)}
 }
 const fault={id:'fault-'+mode,message:'Original later fault',mode},safety={id:mode+'-later-safety',role:'Helper',reason:'helper',sources:[],context:{safetyFault:fault}}
 await r.wake(safety,undefined,[fault]);await drain(r)
 const role={id:mode+'-role-help',role:'Helper',reason:'helper',sources:[],context:{target:{role:'Worker',workId:'actual-worker'},facts:'Actual later role problem'}}
 await r.wake(role);await drain(r)
 const peer='state/Helper_B_'+hash('other-host');await write(peer,'')
 let snapshot=await api.call('snapshot','dss_snapshot');check(snapshot.notifications.length,4);check(snapshot.notifications.includes(peer),false)
 const list=r.records.list.bind(r.records);r.records.list=async()=>{throw Error('Active Helper claim must not scan wake records')}
 const claimed=await api.call('later-claim','dss_claim');r.records.list=list
 check(claimed.helperNotifications.map(w=>w.id).sort(),[initial.id,requests[0].id,requests[1].id,safety.id,role.id].sort())
 check(claimed.helperNotifications.filter(w=>w.context?.observation).map(w=>w.context.observation).sort((a,b)=>a.taskId.localeCompare(b.taskId)),requests.slice(0,2).map(w=>w.context.observation))
 check(r.safetyFaultIds(api.binding),[fault.id]);check(await read(peer),'')
 for(const request of [requests[0],requests[1],safety,role]){const saved=await r.records.get('runtime/wakes/'+hash(request.id));check(saved.delivered,true);check(saved.signalsConsumed,true);check(await read(saved.helperSignal),undefined)}
 // Real Host skips an active Helper. Role-authored top-level empty signals
 // therefore arrive with no pre-existing WakeRecord. The active claim must use
 // normal storeWake discovery, not delete them without an original request or
 // defer them until this round ends. Two ordinary signals retain normal dedup.
 const raw1='state/Helper_A_'+hash(mode+'-planner-authored'),raw2='state/Helper_A_'+hash(mode+'-organizer-authored')
 await write(raw1,'');await write(raw2,'')
 const beforeRaw=await r.records.list('runtime/wakes/');await poll(r,true)
 check((await r.records.list('runtime/wakes/')).length,beforeRaw.length)
 check((await api.call('raw-snapshot','dss_snapshot')).notifications.filter(p=>[raw1,raw2].includes(p)).sort(),[raw1,raw2].sort())
 const raw=await api.call('raw-claim','dss_claim'),rawInputs=raw.helperNotifications.filter(q=>q.reason==='notification'&&q.sources.some(s=>s.path===raw1))
 check(rawInputs.length,1);check(rawInputs[0].context,{helperDebugPath:helperDebugPath(undefined,new Date().toISOString().slice(0,10)),helperDebugDirectory:'debug/helper-debug/host/'});check(rawInputs[0].role,'Helper')
 check(rawInputs[0].sources.map(s=>s.path).sort(),[raw1,raw2].sort())
 check(raw.signals.includes(raw1)&&raw.signals.includes(raw2),true);check(await read(raw1),undefined);check(await read(raw2),undefined)
 const rawSaved=await r.records.get('runtime/wakes/'+hash(rawInputs[0].id))
 check(rawSaved.delivered,true);check(rawSaved.signalsConsumed,true);check(rawSaved.request.sources,rawInputs[0].sources)
 const afterRaw=(await r.records.list('runtime/wakes/')).length;await poll(r);check((await r.records.list('runtime/wakes/')).length,afterRaw)
 // A new physical/snapshot observation is a new normal notification, not a
 // second consumption of the earlier accepted signal or an old context replay.
 await write(raw1,'');const newerRaw=await api.call('raw-again','dss_claim')
 const rawAgain=newerRaw.helperNotifications.filter(q=>q.reason==='notification'&&q.sources.some(s=>s.path===raw1))
 check(rawAgain.length,2);check(new Set(rawAgain.map(q=>q.id)).size,2);check(await read(raw1),undefined)
 // Native recovery and already-selected native admissions retain their own
 // original confirmation path, even while another Helper is able to claim.
 const replacement={id:mode+'-pending-native-replacement',role:'Helper',reason:'helper',sources:[],context:{facts:'Original replacement responsibility'}}
 await r.wake(replacement,{replacesUnadmittedWake:'original-unadmitted',targetExecutionId:'other-execution'});await drain(r)
 const admitting={id:mode+'-pending-native-admission',role:'Helper',reason:'helper',sources:[],context:{facts:'Input already assigned to native admission'}}
 await r.wake(admitting);await drain(r)
 await r.updateWake('runtime/wakes/'+hash(admitting.id),q=>({...q,admission:{phase:'sending',executionId:'admitting-execution'}}))
 const guarded=await api.call('guarded-claim','dss_claim')
 for(const q of [replacement,admitting]){
  const pending=await r.records.get('runtime/wakes/'+hash(q.id));check(guarded.helperNotifications.some(w=>w.id===q.id),false)
  check(guarded.signals.includes(pending.helperSignal),false);check(pending.delivered,undefined);check(pending.signalsConsumed,undefined);check(await read(pending.helperSignal),'')
 }
 // Retrying the identical claim neither deletes a new publication nor replaces
 // either original recovery cycle with the Safety Net/role context.
 const firstCheck=await r.records.get('runtime/wakes/'+hash(requests[0].id));await write(firstCheck.helperSignal,'')
 await api.call('later-claim','dss_claim');check(await read(firstCheck.helperSignal),'')
 // This third check is published AFTER the last successful claim. It must not
 // count as processed just because this Helper later finishes its own round.
 await r.wake(requests[2]);await drain(r)
 time+=60_000;r.ctx.nativeCapture.finished=false
 await r.finishGitAuxiliaryRound(r.roleRecords.get('Helper'))
 check((await r.records.get(r.watchKey(requests[0].taskId,'A'))).watch.stage,1)
 const firstResetAt=time
 check(await api.call('reset-first','dss_reset_observation',{recoveryCheckId:requests[0].id}),{reset:true,status:'reset',recoveryCheckId:requests[0].id})
 check((await r.records.get(r.watchKey(requests[1].taskId,'A'))).watch.stage,1)
 time+=1_000
 check(await api.call('repeat-first','dss_reset_observation',{recoveryCheckId:requests[0].id}),{reset:false,status:'superseded',recoveryCheckId:requests[0].id})
 check((await r.records.get(r.watchKey(requests[0].taskId,'A'))).watch.cycleStartedAt,firstResetAt)
 r.ctx.nativeCapture.finished=true;await r.finishGitAuxiliaryRound(r.roleRecords.get('Helper'))
 // Finishing the native round does not finish a second claimed recovery check.
 check((await r.records.get(r.watchKey(requests[1].taskId,'A'))).watch.stage,1)
 check(await api.call('reset-second','dss_reset_observation',{recoveryCheckId:requests[1].id}),{reset:true,status:'reset',recoveryCheckId:requests[1].id})
 for(const [index,request] of requests.slice(0,2).entries()){const watch=(await r.records.get(r.watchKey(request.taskId,'A'))).watch;check(watch.stage,0);check(watch.cycleStartedAt,index===0?firstResetAt:time);check(await read(request.sources[0].path),'')}
 check((await r.records.get(r.watchKey(requests[2].taskId,'A'))).watch.stage,1)
 const third=await r.records.get('runtime/wakes/'+hash(requests[2].id));check(third.delivered,undefined);check(await read(third.helperSignal),'')
 await assert.rejects(api.call('reset-unclaimed','dss_reset_observation',{recoveryCheckId:requests[2].id}),/Select an actual member recovery check/);assertions++
 check((await r.records.get(r.watchKey(requests[2].taskId,'A'))).watch.stage,1)
 // Safety repair is attributed to its own original adopted wake, not initial.
 await r.recordSafetyAttempt(api.binding,{faultId:fault.id,actionsTaken:'Actual repair',outcome:'repaired',result:'Original continuation restored'},mode+'-repair')
 check((await r.records.get('runtime/wakes/'+hash(safety.id))).safetyAttempts.length,1);check((await r.records.get('runtime/wakes/'+hash(initial.id))).safetyAttempts,undefined)
 if(r.files instanceof PhysicalLocalFiles)await r.files.close()
}
try{
 await scenario('local');await scenario('git')
 // Controlled signal-deletion failure exercises retained claim responsibility,
 // not a naturally observed storage fault. Neither failed output nor a resumed
 // binding or completed native round automatically resets its check.
 state.clear();const r=runtime();r.files=new PhysicalLocalFiles(path.join(scratch,'failed-claim'));r.safetyEpisodes=new Map();r.resolvedSafetyFaultIds=new Set();r.environment={};r.ctx.events=[]
 const initial={id:'failed-initial',role:'Helper',reason:'helper',sources:[],context:{facts:'initial responsibility'}}
 await r.wake(initial);await drain(r);await poll(r);const record=await owner(r,await records.get('runtime/wakes/'+hash(initial.id)));const api=toolsFor(r,record)
 await api.call('initial','dss_claim')
 const taskId='10000000-0000-4000-8000-000000000008',observation={kind:'recovery-check',taskId,member:'A',cycleStartedAt:time-9999,stage:1}
 await r.records.set(r.watchKey(taskId,'A'),{watch:{...observation,stageStartedAt:time-9999}})
 const request={id:'failed-check',role:'Helper',reason:'observation',taskId,sources:[],context:{observation}}
 await r.wake(request);await drain(r)
 const remove=r.files.deleteObserved.bind(r.files);r.files.deleteObserved=async()=>{throw Error('Controlled signal deletion interruption')}
 await assert.rejects(api.call('failed-later','dss_claim'),/Controlled signal deletion interruption/);assertions++;r.files.deleteObserved=remove
 r.ctx.nativeCapture.finished=true;await r.finishGitAuxiliaryRound(r.roleRecords.get('Helper'))
 check((await r.records.get(r.watchKey(taskId,'A'))).watch.stage,1)
 const accepted=r.roleRecords.get('Helper'),replacement={...accepted,identity:{...accepted.identity,executionId:'replacement-helper'},sessionId:'replacement-session',gitSettledWakeId:undefined,lastWake:{...initial,id:'replacement-initial',context:{...initial.context,notificationClaims:accepted.notificationClaims}}}
 await r.saveRole(replacement)
 check(r.binding(replacement,replacement.lastWake).helperNotifications.find(w=>w.id===request.id).context.observation,observation)
 await r.finishGitAuxiliaryRound(replacement)
 check((await r.records.get(r.watchKey(taskId,'A'))).watch.stage,1)
 const resumed=toolsFor(r,replacement);r.ctx.events=[];r.ctx.nativeCapture.finished=false
 await resumed.call('resume-claim','dss_claim');check((await r.records.get('runtime/wakes/'+hash(request.id))).delivered,true)
 time+=10_000;r.ctx.nativeCapture.finished=true;await r.finishGitAuxiliaryRound(r.roleRecords.get('Helper'))
 check((await r.records.get(r.watchKey(taskId,'A'))).watch.stage,1)
 check(await resumed.call('resume-reset','dss_reset_observation',{recoveryCheckId:request.id}),{reset:true,status:'reset',recoveryCheckId:request.id})
 check((await r.records.get(r.watchKey(taskId,'A'))).watch.stage,0);check((await r.records.get(r.watchKey(taskId,'A'))).watch.cycleStartedAt,time)
 await r.files.close()
 console.log(JSON.stringify({status:'passed',assertions,limits:'Actual source dss_snapshot/dss_claim/dss_reset_observation, Host notification/claim/settlement and explicit-reset method bodies, real Physical and GitFiles/GitAuthority stores. Schema/Markdown/skill hooks, native session events/capture and RoleRecord persistence are explicit controlled ports; the retained failed-claim scenario deliberately injects a deletion error and does not establish a natural failure. No direct native injection/ACK/new wake-discovery scan; generated claims use exact keys and role-authored signals reuse the existing Host storeWake lookup, no full native DSH/Windows/typecheck acceptance.',sourceHashes:{...Object.fromEntries(loaded),'framework/role-runtime.ts':createHash('sha256').update(source).digest('hex')}},null,2))
}finally{Date.now=originalNow;await files.close();await fs.rm(scratch,{recursive:true,force:true});hooks.deregister()}
