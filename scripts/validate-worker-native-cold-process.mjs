import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {serialize,deserialize} from 'node:v8'
process.env.DSS_WORKER_HARNESS_ONLY='1'
const {fixture,worker,settle,read,check,checks,trace,faults,root}=await import('./validate-worker-native-retirement.mjs')
const {evidence}=await import('./test-support/dsh-sdk-runtime.mjs')
const {Repository}=await import('./test-support/controlled-git/repository.mjs')
const mode=process.env.DSS_COLD_MODE??'local',name=mode+'-real-process-cold',phase=process.env.DSS_COLD_PHASE
await fs.mkdir(root,{recursive:true})
if(phase==='produce'){
 const f=await fixture(mode,name),w=await worker(f,name),id=w.record.sessionId
 faults.set(id,{error:new Error('CONTROLLED: original native journal acceptance fails before process exit')})
 await w.transfer('relay');await settle(f.rt)
 const row=await f.records.get(w.retiredKey)
 assert.equal(row.stopped,true);assert.equal(row.stopIntent.phase,'disposed');assert.equal(row.nativeRetirements.length,1);assert.equal(await w.present(),true)
 await fs.writeFile(path.join(root,'handoff.json'),JSON.stringify({record:w.record,retiredKey:w.retiredKey,marker:w.marker,nativeFile:w.nativeFile,originalRow:row,trace,...evidence()},null,2))
 if(f.repo)await fs.writeFile(path.join(root,'controlled-remote.bin'),serialize({bodies:f.repo.bodies,head:f.repo.head,history:f.repo.history,accepted:f.repo.accepted}))
 process.exit(42) // Deliberate abrupt test process exit; no plugin/runtime teardown.
}else if(phase==='recover'){
 const old=JSON.parse(await fs.readFile(path.join(root,'handoff.json'),'utf8'))
 const repo=mode==='git'?Object.assign(new Repository(),deserialize(await fs.readFile(path.join(root,'controlled-remote.bin')))):undefined
 const f=await fixture(mode,name,{repo})
 try{
  f.rt.loop.actions.wake=async request=>{trace.push(['observed-existing-business-wake',request.role]);return false}
  await f.rt.start();await f.rt.loop.stop();await settle(f.rt)
  const row=await f.records.get(old.retiredKey)
  check('fresh process reloaded original stopped worker',row.stopped,true)
  check('fresh process cleared exact pending after real acceptance',row.nativeRetirements,undefined)
  check('fresh process retained original transfer',!!await read(f,old.marker),true)
  check('fresh process original native file removed',await fs.access(old.nativeFile).then(()=>true,()=>false),false)
  check('fresh process precise Session unchanged',row.sessionId,old.record.sessionId)
  await fs.writeFile(path.join(root,'recovery.json'),JSON.stringify({status:'passed',checks:checks.length,checkNames:checks,trace,...evidence()},null,2))
 }finally{await f.close()}
}else{
 const runs=[]
 for(const selected of ['local','git']){
  const dir=path.join(root,selected)
  for(const stage of ['produce','recover']){
   const child=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(import.meta.url)],{env:{...process.env,DSS_COLD_MODE:selected,DSS_COLD_PHASE:stage,DSS_WORKER_EVIDENCE_ROOT:dir},encoding:'utf8'})
   await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,stage+'.log'),child.stdout+child.stderr)
   assert.equal(child.status,stage==='produce'?42:0,selected+' '+stage+'\n'+child.stderr)
   runs.push({mode:selected,stage,exit:child.status})
  }
 }
 console.log(JSON.stringify({status:'passed',runs,root,limits:'Two actual abrupt producer exits and two fresh Node processes. Official DSH/JSONL/SQLite and production Runtime startup. Git remote transport state serialized solely as controlled fixture transport, not a live remote server. Business wake port observed without sending a model request.'},null,2))
}
