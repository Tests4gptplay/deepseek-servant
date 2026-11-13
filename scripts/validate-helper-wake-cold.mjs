// Real SDK JSON storage + JSONL and separate process exit, no model/network.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {evidence,hash} from './test-support/dsh-sdk-runtime.mjs'
import {localFixture} from './helper-retirement-local-fixture.mjs'
const jsonl=await import('@deepseek-ai/dsh-session-persistence-jsonl')
const {SESSION_FORMAT_VERSION}=await import('@deepseek-ai/dsh-session')
const {SessionProjectionRegistry}=await import('@deepseek-ai/dsh-session-projection')
const {AgentLoop}=await import('@deepseek-ai/dsh-agent-loop')
const {withSnapshot}=await import('../src/framework/transactions.ts')
async function persistence(f,dir){const plugin=f.sdk.ctx.plugin(jsonl,{root:path.join(dir,'native'),compression:'none'});await plugin.await();return f.sdk.ctx.sessionPersistence}
if(process.argv[2]?.startsWith('--child-')){
 const dir=process.argv[3],f=await localFixture(dir),w=await f.addWake();f.actual.inbox={nextTurn:[],nextStep:[]};f.rt.continueNativeRetirements=()=>{}
 f.add('turn/start',{turn:1});f.input();f.closeTurn()
 const store=await persistence(f,dir),handle=await store.create({id:f.record.sessionId,version:SESSION_FORMAT_VERSION,createdAt:1,cwd:dir,isSeeded:false,delegationDepth:0})
 await handle.append(f.events);await handle.flush();await handle.close()
 const del=f.sdk.adapter.delete.bind(f.sdk.adapter)
 f.sdk.adapter.delete=async key=>{if(key===w.k){if(process.argv[2]==='--child-exit')process.exit(86);throw Error('exact delete unavailable')}return del(key)}
 try{await f.rt.retainClosedRound(f.record,f.owned)}catch(e){if(process.argv[2]==='--child-failure'&&e.message==='exact delete unavailable')process.exit(87);throw e}
 throw Error('Did not reach exact deletion boundary')
}
const root=await fs.mkdtemp(path.join(os.tmpdir(),'helper-retirement-cold-')),results=[]
try{
 for(const kind of ['exit','failure']){
  const dir=path.join(root,kind),child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--child-'+kind,dir],{encoding:'utf8',timeout:30000})
  assert.equal(child.status,kind==='exit'?86:87,child.stderr)
  const f=await localFixture(dir,'Helper',true)
  try{
   const store=await persistence(f,dir),ctx=f.sdk.ctx;new SessionProjectionRegistry(ctx);ctx.provide('agents',{setFactory:()=>()=>{}});ctx.provide('systemPrompt',{variable(){}});new AgentLoop(ctx,{agents:[],maxParallelToolCalls:1})
   const record=f.rt.roleRecords.get(f.record.identity.workId),key=f.key('wakes',record.delivery.request.id)
   assert.equal(record.gitSettledWakeId,record.delivery.request.id);assert.ok(await f.sdk.adapter.get(key))
   f.rt.ctx={sessions:{get:()=>undefined},agents:{get:()=>undefined},jobs:{list:()=>[]},get:n=>n==='sessionPersistence'?store:n==='sessionProjections'?ctx.sessionProjections:undefined}
   Object.assign(f.rt,{active:()=>false,scanMembers:async()=>[],currentTask:async()=>undefined,diagnoseMissingTask:async()=>false,memberContinuationEligible:async()=>true,error:e=>{throw e}})
   await f.rt.startupRecovery({workId:record.identity.workId,facts:{restoring:new Set(),recovered:new Set()}})
   assert.equal(await f.sdk.adapter.get(key),undefined);assert.equal(await f.rt.wake(record.delivery.request),false)
   const signal='state/Helper_A_'+hash(record.delivery.request.id);await f.rt.publishHelperSignal({request:record.delivery.request,helperSignal:signal})
   assert.equal(await withSnapshot(f.files,s=>f.files.read(s,signal)),undefined)
   results.push({kind,childExit:child.status,childStdout:child.stdout,childStderr:child.stderr,coldStartupRetired:true,oldIdAndLatePublisherDidNotRecreate:true})
  }finally{await f.close()}
 }
 console.log(JSON.stringify({results,...evidence(),limits:'Actual separate process exit, persisted role/wake SDK storage and real JSONL native events; production targeted startupRecovery entry. Native event content and ownership adapters are controlled, not model execution.'},null,2))
}finally{await fs.rm(root,{recursive:true,force:true})}
