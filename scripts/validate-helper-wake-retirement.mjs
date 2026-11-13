// Actual production runtime, actual SDK modules/storage/projection definitions.
// Native event append/flush and repository failure points are controlled ports.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {evidence,hash} from './test-support/dsh-sdk-runtime.mjs'
import {gitFixture} from './helper-retirement-git-fixture.mjs'
import {localFixture} from './helper-retirement-local-fixture.mjs'
import {openDshStorageFixture} from './test-support/dsh-sdk-storage.mjs'
const {Context}=await import('@deepseek-ai/cordis')
const {SessionProjectionRegistry}=await import('@deepseek-ai/dsh-session-projection')
const {AgentLoop}=await import('@deepseek-ai/dsh-agent-loop')
const {GitAuthorityStore}=await import('../src/framework/git-authority.ts')
const {FrameworkTransactions}=await import('../src/framework/command-transactions.ts')
const {withSnapshot,FilesOutcomeUnknownError,FilesConflictError}=await import('../src/framework/transactions.ts')
const {put}=await import('./test-support/controlled-git/repository.mjs')
const root=await fs.mkdtemp(path.join(os.tmpdir(),'helper-retirement-'))
let count=0;const results=[]
function check(actual,expected){assert.deepEqual(actual,expected);count++}
async function fixture(mode,name){
 const dir=path.join(root,mode+'-'+name),f=mode==='git'?await gitFixture():await localFixture(dir)
 f.dir=dir;f.mode=mode;f.records=f.records??f.sdk.adapter;f.request=f.record.delivery.request
 f.actual.inbox={nextTurn:[],nextStep:[]};f.actual.status='idle';f.rt.active=()=>false
 f.rt.continueNativeRetirements=()=>{};f.rt.safetyRequests=new Map();f.rt.taskNotices=new Map();f.rt.config.primary=true
 f.rt.transactions??=new FrameworkTransactions(f.files,f.records,'test')
 f.rt.ctx.jobs={list:()=>[]};let flushes=0;f.rt.ctx.sessions.flush=async()=>{flushes++}
 f.flushCount=()=>flushes
 f.done=()=>f.add('turn/end',{turn:1,reason:{kind:'completed'}})
 f.own=()=>f.rt.roleRecords.get(f.record.identity.workId)
 f.finish=()=>f.rt.retainClosedRound(f.own(),f.owned)
 const oldAdd=f.addWake
 f.addWake=extra=>mode==='git'?oldAdd(extra):oldAdd(f.request.id,extra)
 f.write=async(p,text)=>mode==='git'?withSnapshot(f.files,s=>f.files.commit(s,[{path:p,content:text}],'fixture '+Math.random())):text===null?f.files.delete(p):f.files.replace(p,text)
 f.read=p=>withSnapshot(f.files,s=>f.files.read(s,p))
 f.closeAll=async()=>{if(mode==='local')await f.close();else await f.files.close?.()}
 return f
}
function projection(f){
 const ctx=new Context();new SessionProjectionRegistry(ctx)
 ctx.provide('agents',{setFactory:()=>()=>{}});ctx.provide('systemPrompt',{variable(){}})
 new AgentLoop(ctx,{agents:[],maxParallelToolCalls:1})
 const get=f.rt.ctx.get;f.rt.ctx.get=name=>name==='sessionProjections'?ctx.sessionProjections:name==='sessionPersistence'?{stat:async()=>({sizeBytes:1})}:get(name)
 return ctx
}
async function scenario(mode,name,run){let f;const before=count;try{f=await fixture(mode,name);await run(f);results.push({mode,name,pass:true,checks:count-before})}catch(e){results.push({mode,name,pass:false,error:{name:e.name,message:e.message,stack:e.stack}})}finally{await f?.closeAll()}}
for(const mode of ['local','git']){
 await scenario(mode,'completed-consumed-and-original-replay',async f=>{
  const w=await f.addWake();f.input();f.done();await f.finish();check(await f.records.get(w.k),undefined)
  check(f.own().gitSettledWakeId,f.request.id);check(await f.rt.wake(f.request),false);check(await f.records.get(w.k),undefined)
  await f.rt.publishHelperSignal({request:f.request,helperSignal:'state/Helper_A_'+hash(f.request.id)})
  check(await f.read('state/Helper_A_'+hash(f.request.id)),undefined)
  const originalGet=f.records.get.bind(f.records);let reads=0;f.records.get=async(...args)=>{reads++;return originalGet(...args)}
  await f.rt.finishGitAuxiliaryRound(f.own());await f.rt.finishGitAuxiliaryRound(f.own());check(reads,0)
 })
 for(const kind of ['missing-input','queued-input','unconfirmed-delivery','pending-tool','aborted-turn','unknown-stop'])await scenario(mode,kind,async f=>{
  const w=await f.addWake()
  if(kind!=='missing-input')f.input()
  if(kind==='queued-input')f.actual.inbox.nextTurn.push({id:'queued',role:'user',content:[],source:{kind:'deepseek-servant'}})
  if(kind==='unconfirmed-delivery')f.record.delivery.confirmed=false
  if(kind==='pending-tool')f.call('pending','dss_snapshot')
  if(kind==='unknown-stop')f.record.stopUnknown={reason:'unknown native stop',jobs:['job']}
  if(kind==='aborted-turn')f.add('turn/end',{turn:1,reason:{kind:'aborted',reason:{kind:'user'}}});else f.done()
  await f.finish();check(!!await f.records.get(w.k),true)
 })
 for(const kind of ['recovery','parent','fault','resolved-fault','source-not-consumed'])await scenario(mode,'retain-'+kind,async f=>{
  const extra=kind==='recovery'?{recovery:{targetExecutionId:'old'}}:kind==='parent'?{safetyParentWakeId:'parent'}:kind==='fault'?{safetyFaults:[{id:'fault',operationId:'unknown'}]}:kind==='resolved-fault'?{resolvedSafetyFaultIds:['fault']}:{helperSignal:'state/Helper_A_x'}
  const w=await f.addWake(extra);f.input();f.done();await f.finish();check(!!await f.records.get(w.k),true)
 })
 await scenario(mode,'actual-source-consume-then-late-same-path',async f=>{
  const p='state/Helper_A_'+hash(f.request.id);await f.write(p,'');const source=await withSnapshot(f.files,async s=>(await f.files.listDirectory(s,'state/',{paths:[p]})).find(x=>x.path===p))
  f.request.sources=[{path:p,version:source.version}];await f.rt.saveRole(f.record)
  const w=await f.addWake({request:f.request,helperSignal:p});f.input();await f.rt.consumeWakeSignals(f.rt.binding(f.own(),f.request));check(await f.read(p),undefined)
  await f.write(p,'late notification');f.done();await f.finish();check(await f.records.get(w.k),undefined);check(await f.read(p),'late notification')
 })
 await scenario(mode,'claimed-exact-result-only',async f=>{
  const a=await f.addWake(),later={id:'later',role:'Helper',reason:'helper',sources:[],context:{facts:'exact later input'}}
  const wrong={...later,id:'wrong'},k=f.key('wakes','later'),bad=f.key('wakes','wrong')
  await f.rt.updateWake(k,()=>({request:later,delivered:true}));await f.rt.updateWake(bad,()=>({request:wrong,delivered:true}))
  await f.rt.saveRole({...f.record,notificationClaims:{claim:{commandId:'claim',executionId:f.record.identity.executionId,wakeId:f.request.id,initialSignals:[],sources:[],helperWakes:[later,wrong]}}})
  f.input();f.call('claim','dss_claim');f.result('claim',...(mode==='local'?[false,JSON.stringify({helperNotifications:[later,{...wrong,context:{facts:'wrong'}}]})]:[JSON.stringify({helperNotifications:[later,{...wrong,context:{facts:'wrong'}}]})]));f.done();await f.finish()
  check(await f.records.get(a.k),undefined);check(await f.records.get(k),undefined);check(!!await f.records.get(bad),true)
 })
 await scenario(mode,'restore-current-input-retained',async f=>{
  const w=await f.addWake();f.input();f.call('restore','dss_restore');f.result('restore',...(mode==='local'?[false,'{"arranged":true}']:['{"arranged":true}']));f.done();await f.finish();check(!!await f.records.get(w.k),true)
 })
 await scenario(mode,'host-restore-accepted-row-outlives-plain-wake',async f=>{
  const w=await f.addWake();f.input();f.call('host-restore','dss_restore_host')
  const command=f.actual.id+':host-restore',binding=f.rt.binding(f.own(),f.request)
  await f.rt.services().helper.restoreHost(binding,{facts:'Host is running',hypotheses:'Restore the existing host responsibilities',actionsTaken:'Read the actual input',continuation:'Continue existing host restoration'},command)
  const key=f.key('host-restores',command);check((await f.records.get(key)).complete,false)
  f.result('host-restore',...(mode==='local'?[false,'{"arranged":true}']:['{"arranged":true}']));f.done();await f.finish()
  check(await f.records.get(w.k),undefined);check((await f.records.get(key)).complete,false)
 })
 await scenario(mode,'host-restore-safety-wake-is-retained',async f=>{
  const w=await f.addWake({safetyFaults:[{id:'original-safety-fault'}]});f.input();f.call('host-restore','dss_restore_host')
  f.result('host-restore',...(mode==='local'?[false,'{"arranged":true}']:['{"arranged":true}']));f.done();await f.finish()
  check((await f.records.get(w.k)).safetyFaults[0].id,'original-safety-fault')
 })
 await scenario(mode,'accepted-restore-and-concurrent-fault-preserve-responsibility',async f=>{
  const w=await f.addWake();f.add('turn/start',{turn:1});f.input();f.call('accepted-restore','dss_restore')
  const binding=f.rt.binding(f.own(),f.request),command=f.actual.id+':accepted-restore'
  await f.rt.services().helper.restore(binding,{target:{role:'Foreground',workId:'original-target',executionId:'target-execution'},facts:'actual failure',hypotheses:'checked target',actionsTaken:'preserved originals',continuation:'resume original'},command)
  const key=f.key('restores',command);check((await f.records.get(key)).complete,false)
  const fault={id:'restore-fault',mode,scope:'test',role:'Helper',identity:f.record.identity,message:'actual Helper fault while restore accepted',source:'native'}
  await f.rt.arrangeSafetyRepair(fault)
  f.result('accepted-restore',...(mode==='local'?[false,'{"arranged":true}']:['{"arranged":true}']));f.done();await f.finish()
  check((await f.records.get(key)).complete,false);check((await f.records.get(w.k)).safetyFaults[0].id,fault.id)
 })
 await scenario(mode,'old-restore-does-not-pin-new-input',async f=>{
  f.add('user/message',{id:'older-input',role:'user',content:[],source:{kind:'deepseek-servant'}},{surfaceOp:'append'});f.call('old-restore','dss_restore');f.result('old-restore',...(mode==='local'?[false]:[]));f.done()
  const w=await f.addWake();f.input();f.done();await f.finish();check(await f.records.get(w.k),undefined)
 })
 await scenario(mode,'replacement-after-save-before-retire',async f=>{
  const w=await f.addWake();f.input();f.done();const save=f.rt.saveRole.bind(f.rt)
  f.rt.saveRole=async(...args)=>{await save(...args);f.rt.roleRecords.set(f.record.identity.workId,{...f.own(),identity:{...f.record.identity,executionId:'replacement'}})}
  await f.finish();check(!!await f.records.get(w.k),true)
 })
 await scenario(mode,'delete-failure-original-idle-retry',async f=>{
  const w=await f.addWake();f.input();f.done();const method=mode==='git'?'compareAndDelete':'delete',original=f.records[method].bind(f.records);let first=true
  f.records[method]=async(...args)=>{if(first){first=false;throw Error('injected exact delete failure')}return original(...args)}
  await assert.rejects(f.finish(),/injected exact delete failure/);count++;check(f.own().gitSettledWakeId,f.request.id);check(!!await f.records.get(w.k),true)
  await f.rt.finishGitAuxiliaryRound(f.own());check(await f.records.get(w.k),undefined)
 })
 await scenario(mode,'late-fault-exact-wake-lane-retained',async f=>{
  const w=await f.addWake();f.input();f.done();let release;const gate=new Promise(r=>release=r)
  f.rt.wakeWrites.set(w.k,gate);const finish=f.finish();await new Promise(setImmediate)
  const row=await f.records.get(w.k);if(mode==='git')await f.records.update(w.k,current=>({write:true,value:{...current,safetyFaults:[{id:'late-real-fault'}]},result:undefined}));else await f.records.set(w.k,{...row,safetyFaults:[{id:'late-real-fault'}]});release();await finish
  check((await f.records.get(w.k)).safetyFaults[0].id,'late-real-fault')
 })
 await scenario(mode,'native-child-followup-claim-during-retirement',async f=>{
  const initial=await f.addWake();f.input();const binding=f.rt.binding(f.own(),f.request)
  await f.rt.consumeWakeSignals(binding);f.done()
  let release,entered;const wait=new Promise(r=>release=r),seen=new Promise(r=>entered=r)
  const get=f.records.get.bind(f.records);let armed=true
  f.records.get=async key=>{if(armed&&key===initial.k){armed=false;entered();await wait}return get(key)}
  const finishing=f.finish();await seen
  // Official native subagent settlement can follow up the same parent outside
  // DSS serialWork, without replacing its original DSS delivery identity.
  f.add('turn/start',{turn:2});f.add('user/message',{id:'native-child-settlement',role:'user',content:[],source:{kind:'agent'}},{surfaceOp:'append'})
  const request={id:'later-native-followup-diagnostic',role:'Helper',reason:'helper',sources:[],context:{facts:'later diagnostic'}}
  const p='state/Helper_A_'+hash(request.id),key=f.key('wakes',request.id)
  await f.rt.updateWake(key,()=>({request,helperSignal:p}));await f.write(p,'')
  f.call('native-followup-claim','dss_claim')
  const result=await f.rt.services().claimNotifications(binding,'native-followup-claim')
  check(result.helperNotifications.some(x=>x.id===request.id),true)
  f.result('native-followup-claim',...(mode==='local'?[false,JSON.stringify(result)]:[JSON.stringify(result)]));f.done()
  const newer=f.own();release();await finishing
  check(f.rt.helperRetirementChecked===newer,false)
  check((await get(key)).delivered,true)
  await f.rt.finishGitAuxiliaryRound(newer)
  check(await get(key),undefined)
 })
 await scenario(mode,'new-fault-after-retirement-reconstructs-owned-input',async f=>{
  const w=await f.addWake();f.input();f.done();await f.finish();check(await f.records.get(w.k),undefined)
  const fault={id:'new-real-fault',mode,scope:'test',role:'Helper',identity:f.record.identity,message:'actual new fault',source:'native'}
  await f.rt.arrangeSafetyRepair(fault);const row=await f.records.get(w.k);check(row.safetyFaults[0].id,fault.id);check(row.request.id,f.request.id)
 })
 for(const negative of ['unconfirmed','unsettled','not-consumed'])await scenario(mode,'missing-wake-fault-'+negative,async f=>{
  if(negative!=='not-consumed')f.input();f.done()
  await f.rt.saveRole({...f.record,...negative==='unsettled'?{}:{gitSettledWakeId:f.request.id},delivery:{...f.record.delivery,confirmed:negative!=='unconfirmed'}})
  if(negative==='unconfirmed'){
   const prepared={...f.own(),delivery:{...f.own().delivery,confirmed:false}},key=f.key('roles',f.record.identity.workId)
   if(mode==='git')await f.records.update(key,()=>({write:true,value:prepared,result:undefined}));else await f.records.set(key,prepared)
   f.rt.roleRecords.set(prepared.identity.workId,prepared);f.rt.roleBases?.set(prepared.identity.workId,structuredClone(prepared))
  }
  const fault={id:'negative-fault',mode,scope:'test',role:'Helper',identity:f.record.identity,message:'actual new fault',source:'native'}
  await assert.rejects(f.rt.arrangeSafetyRepair(fault),/unavailable/);count++;check(await f.records.get(f.key('wakes',f.request.id)),undefined)
 })
 await scenario(mode,'startup-known-settled-retry-after-delete-failure',async f=>{
  projection(f);const w=await f.addWake();f.input();f.done();const method=mode==='git'?'compareAndDelete':'delete',del=f.records[method].bind(f.records)
  f.records[method]=async()=>{throw Error('crash before exact delete')};await assert.rejects(f.finish(),/crash before exact delete/);count++;f.records[method]=del
  const saved=await f.records.get(f.key('roles',f.record.identity.workId));f.rt.roleRecords.set(saved.identity.workId,structuredClone(saved));f.rt.helperRetirementChecked=undefined
  f.rt.scanMembers=async()=>[];f.rt.currentTask=async()=>undefined;f.rt.diagnoseMissingTask=async()=>false;f.rt.memberContinuationEligible=async()=>true;f.rt.error=(e)=>{throw e}
  await f.rt.startupRecovery({workId:saved.identity.workId,facts:{restoring:new Set(),recovered:new Set()}})
  check(await f.records.get(w.k),undefined)
 })
 await scenario(mode,'finish-entry-freezes-pre-flush-prefix',async f=>{
  projection(f);const w=await f.addWake(),later={id:'after-barrier',role:'Helper',reason:'helper',sources:[],context:{facts:'B'}},k=f.key('wakes',later.id)
  await f.rt.updateWake(k,()=>({request:later,delivered:true}))
  f.add('turn/start',{turn:1});f.input();f.done();let flushed=0
  f.rt.ctx.sessions.flush=async()=>{flushed++;if(flushed===2){
   f.add('turn/start',{turn:2});f.add('user/message',{id:'probe-2',role:'user',content:[{type:'text',text:'Check later notifications'}],source:{kind:'deepseek-servant'}},{surfaceOp:'append'});f.add('step/start',{turn:2,step:0})
   f.add('assistant/message',{turn:2,step:0,message:{id:'assistant-B',role:'assistant',source:{kind:'model',provider:'controlled-fixture',model:'controlled-fixture'},content:[{type:'tool-call',id:'B',name:'dss_claim',arguments:'{}'}]}},{surfaceOp:'append'})
   f.call('B','dss_claim');f.events.at(-1).data.turn=2
   await f.rt.saveRole({...f.own(),notificationClaims:{B:{commandId:'B',executionId:f.record.identity.executionId,wakeId:f.request.id,initialSignals:[],sources:[],helperWakes:[later]}}})
   f.result('B',...(mode==='local'?[false,JSON.stringify({helperNotifications:[later]})]:[JSON.stringify({helperNotifications:[later]})]));f.events.at(-1).data.turn=2
   f.add('step/end',{turn:2,step:0});f.add('turn/end',{turn:2,reason:{kind:'completed'}})
  }}
  await f.rt.finishGitAuxiliaryRound(f.own());check(await f.records.get(w.k),undefined);check(!!await f.records.get(k),true);check(flushed,2)
  f.rt.ctx.sessions.flush=async()=>{throw Error('B persistence failed')}
  await assert.rejects(f.rt.finishGitAuxiliaryRound(f.own()),/B persistence failed/);count++;check(!!await f.records.get(k),true)
  f.rt.ctx.sessions.flush=async()=>{};await f.rt.finishGitAuxiliaryRound(f.own());check(await f.records.get(k),undefined)
 })
}
await scenario('git','cas-conflict-does-not-cache-success',async f=>{
 const w=await f.addWake();f.input();f.done();const del=f.records.compareAndDelete.bind(f.records);let once=true
 f.records.compareAndDelete=async(k,v)=>{if(once){once=false;throw new FilesConflictError('known-head')}return del(k,v)}
 await f.finish();check(!!await f.records.get(w.k),true);check(f.rt.helperRetirementChecked,undefined);await f.rt.finishGitAuxiliaryRound(f.own());check(await f.records.get(w.k),undefined)
})
await scenario('git','real-cas-conflict-retains-new-fault',async f=>{
 const w=await f.addWake();f.input();f.done();let once=true
 f.setBefore(async(_snapshot,changes)=>{
  if(once&&changes.some(change=>change.content===null&&change.path.includes('/wakes/'))){once=false;f.setBefore(undefined)
   await f.records.update(w.k,current=>({write:true,value:{...current,safetyFaults:[{id:'concurrent-committed-fault'}]},result:undefined}))
  }
 })
 await f.finish();check((await f.records.get(w.k)).safetyFaults[0].id,'concurrent-committed-fault');check(f.rt.helperRetirementChecked,undefined)
 await f.rt.finishGitAuxiliaryRound(f.own());check((await f.records.get(w.k)).safetyFaults[0].id,'concurrent-committed-fault')
})
await scenario('git','uncertain-retirement-not-replayed-as-native-send',async f=>{
 const w=await f.addWake();f.input();f.done();let once=true;f.setBefore(async(_s,changes)=>{if(once&&changes.some(c=>c.content===null&&c.path.includes('wakes'))){once=false;f.loseAck()}})
 await assert.rejects(f.finish());count++;check(f.own().gitSettledWakeId,f.request.id);check(f.rt.helperRetirementChecked,undefined);check(await f.rt.wake(f.request),false)
})
console.log(JSON.stringify({checks:count,results,...evidence(),limits:'Actual runtime methods and real SDK storage/projection definitions; native event producer, agent ownership registry and flush failures are controlled ports. No live model, Windows or remote Git acceptance claim.'},null,2))
await fs.rm(root,{recursive:true,force:true})
if(results.some(x=>!x.pass))process.exitCode=1
