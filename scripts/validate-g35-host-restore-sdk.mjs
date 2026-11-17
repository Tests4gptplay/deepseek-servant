// Full production runtime, pinned SDK storage/JSONL and real Local/Git stores.
// Native append/status/flush invocation and remote repository transport are
// controlled ports. No model request, Windows run or real GitHub is claimed.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {evidence} from './test-support/dsh-sdk-runtime.mjs'
import {localFixture} from './helper-retirement-local-fixture.mjs'
import {gitFixture} from './helper-retirement-git-fixture.mjs'
import {put,head} from './test-support/controlled-git/repository.mjs'
const {withSnapshot}=await import('../src/framework/transactions.ts')
const {gitCommandReceiptPath}=await import('../src/framework/command-transactions.ts')
const jsonl=await import('@deepseek-ai/dsh-session-persistence-jsonl')
const {SESSION_FORMAT_VERSION}=await import('@deepseek-ai/dsh-session')
const root=await fs.mkdtemp(path.join(os.tmpdir(),'g35-sdk-')),results=[];let count=0
const check=(actual,expected)=>{assert.deepEqual(actual,expected);count++},tick=()=>new Promise(setImmediate)
const input={facts:'Original Host failure.',hypotheses:'Original continuation.',actionsTaken:'Inspect original responsibility.',continuation:'Continue exact owners.'}
async function settle(f){for(;;){const all=[...f.rt.maintenance?.values()??[]];if(!all.length)return;await Promise.allSettled(all);await tick()}}
async function setup(mode,name){
 const dir=path.join(root,mode+'-'+name),f=mode==='local'?await localFixture(dir):await gitFixture()
 f.records??=f.sdk.adapter;f.dir=dir;f.command=f.record.sessionId+':restore-call';f.keyRestore=f.key('host-restores',f.command)
 f.actual.inbox={nextTurn:[],nextStep:[]};f.actual.status='idle';f.rt.active=()=>false;f.rt.continueNativeRetirements=()=>{}
 f.rt.taskMetadata=async()=>[];f.errors=[];f.rt.error=(e,c)=>f.errors.push({e,c});f.flushes=0
 f.rt.ctx.sessions.flush=async()=>{f.flushes++}
 f.wake=await f.addWake();f.add('turn/start',{turn:1});f.input();f.add('step/start',{turn:1,step:1})
 f.add('assistant/message',{turn:1,step:1,message:{id:'model-tool-call',role:'assistant',source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'tool-call',id:'restore-call',name:'dss_restore_host',arguments:JSON.stringify(input)}]}},{surfaceOp:'append'})
 const call=f.add('tool/call',{callId:'restore-call',name:'dss_restore_host',arguments:JSON.stringify(input),turn:1,step:1})
 f.add('tool/result',{message:{id:'result',role:'tool',toolCallId:'restore-call',source:{kind:'tool',callId:'restore-call'},isError:false,content:[{type:'text',text:'{"arranged":true}'}]},turn:1,step:1},{surfaceOp:'append',sourceEventSeqs:[call.seq]})
 f.add('step/end',{turn:1,step:1});f.add('turn/end',{turn:1,reason:{kind:'completed'}})
 if(mode==='local'){
  const plugin=f.sdk.ctx.plugin(jsonl,{root:path.join(dir,'native'),compression:'none'});await plugin.await();f.persistence=f.sdk.ctx.sessionPersistence
  f.handle=await f.persistence.create({id:f.record.sessionId,version:SESSION_FORMAT_VERSION,createdAt:1,cwd:dir,isSeeded:false,delegationDepth:0})
  let saved=false;f.rt.ctx.sessions.flush=async()=>{f.flushes++;if(!saved){await f.handle.append(f.events);saved=true}await f.handle.flush()}
 }
 f.finish=()=>f.rt.retainClosedRound(f.rt.roleRecords.get(f.record.identity.workId),f.owned)
 f.accept=()=>f.rt.services().helper.restoreHost({...f.record.identity,owner:'A'},input,f.command)
 f.process=()=>f.rt.processHostRestores((e,c)=>f.rt.error(e,c))
 f.closeAll=async()=>{await f.handle?.close();if(mode==='local')await f.close();else await f.files.close?.()}
 return f
}
async function scenario(mode,name,run){let f;const before=count;try{f=await setup(mode,name);await run(f);results.push({mode,name,status:'passed',assertions:count-before})}catch(error){results.push({mode,name,status:'failed',assertions:count-before,error:String(error),stack:error.stack})}finally{await f?.closeAll()}}
try{
 for(const mode of ['local','git'])for(const first of ['host','helper'])await scenario(mode,first+'-completes-first',async f=>{
  check(await f.accept(),{arranged:true})
  if(first==='helper'){await f.finish();check((await f.records.get(f.keyRestore)).complete,false);await f.process()}
  else{await f.process();check((await f.records.get(f.keyRestore)).complete,true);await f.finish()}
  await settle(f);check(await f.records.get(f.keyRestore),undefined);if(mode==='git')check(await withSnapshot(f.files,s=>f.files.read(s,gitCommandReceiptPath('host-restore:'+f.command))),undefined);check(f.flushes,1);check(f.errors.length,0);check(f.rt.hostRestoreNativeEvidence?.size??0,0);check(f.rt.completedHostRestores?.size??0,0)
  // A plain consumed wake retires independently of its accepted HostRestore.
  check(!!await f.records.get(f.wake.k),false)
  if(mode==='local'){const log=await f.persistence.open(f.record.sessionId,'read');try{check((await log.read()).events.some(e=>e.type==='tool/result'&&!e.data.message.isError),true)}finally{await log.close()}}
 })
 await scenario('local','existing-flush-failure-keeps-row-and-retry-uses-persisted-jsonl',async f=>{
  await f.accept();await f.process();const flush=f.rt.ctx.sessions.flush;f.rt.ctx.sessions.flush=async()=>{throw Error('Original native flush failed')}
  await assert.rejects(f.finish(),/Original native flush failed/);count++;await settle(f);check(!!await f.records.get(f.keyRestore),true)
  f.rt.ctx.sessions.flush=flush
  await f.rt.retrySettledHelperWakeRetirement(f.rt.roleRecords.get(f.record.identity.workId));await settle(f)
  check(await f.records.get(f.keyRestore),undefined)
 })
 await scenario('git','exact-CAS-conflict-keeps-new-safety-responsibility',async f=>{
  await f.accept();await f.process()
  const remove=f.records.compareAndDelete.bind(f.records);let changed=false
  f.records.compareAndDelete=async(key,expected,...ownedPaths)=>{
   if(key===f.keyRestore&&!changed){changed=true;await f.records.updateOwned(key,'actual-concurrent-safety-update',()=>({write:true,value:{...expected,safetyFaultIds:['new-original-responsibility']},result:undefined}))}
   return remove(key,expected,...ownedPaths)
  }
  await f.finish();await settle(f)
  check((await f.records.get(f.keyRestore)).safetyFaultIds,['new-original-responsibility']);check(!!await withSnapshot(f.files,s=>f.files.read(s,gitCommandReceiptPath('host-restore:'+f.command))),true);check(f.errors.length,1)
  await f.process();await settle(f);check(!!await f.records.get(f.keyRestore),true)
 })
 await scenario('git','unrelated-advanced-head-preserves-other-task-and-retires-exact-row',async f=>{
  await f.accept();await f.process();const remove=f.records.compareAndDelete.bind(f.records);let changed=false
  f.records.compareAndDelete=async(key,expected,...ownedPaths)=>{
   if(key===f.keyRestore&&!changed){changed=true;put(f.repo,'tasks/unrelated.json',{taskId:'unrelated',value:'keep'});head(f.repo)}
   return remove(key,expected,...ownedPaths)
  }
  await f.finish();await settle(f);check(await f.records.get(f.keyRestore),undefined)
  check(JSON.parse(await withSnapshot(f.files,s=>f.files.read(s,'tasks/unrelated.json'))).value,'keep');check(await withSnapshot(f.files,s=>f.files.read(s,gitCommandReceiptPath('host-restore:'+f.command))),undefined);check(f.errors.length,0)
 })
 await scenario('local','cold-native-log-proof-precedes-existing-Host-discovery',async f=>{
  await f.accept();await f.process();await f.rt.ctx.sessions.flush(f.actual.session)
  await f.rt.saveRole({...f.record,gitSettledWakeId:f.record.delivery.request.id})
  await f.closeAll();f.closeAll=async()=>{}
  const cold=await localFixture(f.dir,'Helper',true)
  try{
   const plugin=cold.sdk.ctx.plugin(jsonl,{root:path.join(f.dir,'native'),compression:'none'});await plugin.await()
   cold.rt.ctx.sessions.get=()=>undefined;cold.rt.ctx.get=name=>name==='sessionPersistence'?cold.sdk.ctx.sessionPersistence:undefined
   cold.rt.active=()=>false;cold.rt.continueNativeRetirements=()=>{};cold.rt.taskMetadata=async()=>[]
   const errors=[];cold.rt.error=(e,c)=>errors.push({e,c})
   const role=cold.rt.roleRecords.get(f.record.identity.workId)
   await cold.rt.retrySettledHelperWakeRetirement(role)
   // Exact retirement is already scheduled by the persisted native evidence.
   // Its completion may precede the next discovery; only the settled result is ordered.
   await cold.rt.processHostRestores();await settle(cold)
   check(await cold.sdk.adapter.get(f.keyRestore),undefined);check(!!await cold.sdk.adapter.get(f.wake.k),false);check(errors.length,0);check(cold.rt.hostRestoreNativeEvidence?.size??0,0)
  }finally{await cold.close()}
 })
 const result={status:results.every(r=>r.status==='passed')?'passed':'failed',assertions:count,results,...evidence(),limits:'Full production runtime and installed SDK projection imports, actual JSONL append/flush/read and Local SDK technical KV; actual GitFiles/GitAuthorityStore with controlled remote transport. Native status/events are SDK-shaped controlled input, not a model run. No Windows, remote Git or user data was exercised.'}
 console.log(JSON.stringify(result,null,2));if(result.status!=='passed')process.exitCode=1
}finally{await fs.rm(root,{recursive:true,force:true})}
