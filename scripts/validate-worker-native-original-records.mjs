import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
process.env.DSS_WORKER_HARNESS_ONLY='1'
const {fixture,worker,settle,read,check,checks,trace,root}=await import('./validate-worker-native-retirement.mjs')
const {evidence}=await import('./test-support/dsh-sdk-runtime.mjs')
const {paths}=await import('../src/framework/task-files.ts')
const hash=v=>createHash('sha256').update(v).digest('hex')
const rows=[],tick=()=>new Promise(setImmediate)
for(const mode of ['local','git']){
 const f=await fixture(mode,mode+'-pending-removal-failure')
 try{
  const w=await worker(f,f.name),method=mode==='local'?'set':'update',original=f.records[method].bind(f.records);let failed=false
  f.records[method]=async(key,...args)=>{
   if(key===w.retiredKey&&!failed){const row=await f.records.get(key);if(row?.stopped&&row.nativeRetirements?.length){failed=true;throw Error('CONTROLLED: original pending removal write fails after Cleaner acceptance')}}
   return original(key,...args)
  }
  await w.transfer('relay');await settle(f.rt)
  check(mode+' pending clear failure actually reached',failed,true)
  check(mode+' already accepted physical work can finish',await w.present(),false)
  check(mode+' original pending remains retryable',(await f.records.get(w.retiredKey)).nativeRetirements.length,1)
  await f.rt.loop.observeLocal();await settle(f.rt)
  check(mode+' retry clears original pending without new receipt',(await f.records.get(w.retiredKey)).nativeRetirements,undefined)
  check(mode+' original transfer retained',!!await read(f,w.marker),true)
  rows.push({mode,scenario:'pending-removal-failure',status:'passed'})
 }finally{await f.close()}
}
{
 const f=await fixture('local','local-removal-release-overlap')
 try{
  const w=await worker(f,f.name),entered=Promise.withResolvers(),gate=Promise.withResolvers(),get=f.records.get.bind(f.records);let held=false
  f.records.get=async key=>{const row=await get(key);if(key===w.retiredKey&&row?.stopped&&row.nativeRetirements?.length&&!held){held=true;entered.resolve();await gate.promise}return row}
  await w.transfer('deliver');await entered.promise
  const task={...w.task,status:'complete'};await f.write(paths.task(task.taskId),JSON.stringify(task))
  const releasing=f.rt.loop.actions.releaseTask(task.taskId,task.lifecycleId,task);releasing.catch(()=>{})
  await tick();gate.resolve();await releasing;await settle(f.rt)
  check('late pending removal cannot resurrect Local retired row',await get(w.retiredKey),undefined)
  check('late pending removal cannot resurrect transfer',await read(f,w.marker),undefined)
  rows.push({mode:'local',scenario:'pending-removal-and-Task-release-overlap',status:'passed'})
 }finally{await f.close()}
}
{
 const f=await fixture('local','local-new-transfer-read-failure')
 try{
  const w=await worker(f,f.name),readFile=f.files.read.bind(f.files);let failed=false
  f.files.read=async(snapshot,p,...rest)=>{const value=await readFile(snapshot,p,...rest);if(p===w.marker&&value&&!failed&&JSON.parse(value).physical?.published){failed=true;throw Error('CONTROLLED: committed exact transfer reread failed')}return value}
  await assert.rejects(w.transfer('relay'),/committed exact transfer reread failed/);checks.push('new precise read failure remains original tool failure')
  check('accepted transfer pending survives failed committed read',JSON.parse(await read(f,w.marker)).record.nativeRetirements.length,1)
  check('read failure does not claim stopped or delete native',await w.present(),true)
  await f.rt.reconcileWorkerTransfers(false);await settle(f.rt)
  check('existing reconciliation owns accepted transfer after read failure',(await f.records.get(w.retiredKey)).stopped,true)
  check('existing reconciliation accepts precise native cleanup',await w.present(),false)
  rows.push({mode:'local',scenario:'committed-exact-transfer-read-failure',status:'passed'})
 }finally{await f.close()}
}
{
 const f=await fixture('local','local-transfer-not-accepted')
 try{
  const w=await worker(f,f.name),replace=f.files.replace.bind(f.files)
  f.files.replace=async(p,v)=>{if(p===w.marker)throw Error('CONTROLLED: original transfer acceptance not committed');return replace(p,v)}
  await assert.rejects(w.transfer('relay'),/original transfer acceptance not committed/);checks.push('failed transfer acceptance is not native retirement')
  check('failed transfer has no marker',await read(f,w.marker),undefined)
  check('failed transfer did not create retired record',await f.records.get(w.retiredKey),undefined)
  check('failed transfer did not add pending to original role',(await f.records.get(w.key)).nativeRetirements,undefined)
  check('failed transfer still has exact live producer',f.rt.native.get(w.record.identity.workId)?.sessionId,w.record.sessionId)
  check('failed transfer native log preserved',await w.present(),true)
  f.files.replace=replace
  rows.push({mode:'local',scenario:'transfer-not-accepted',status:'passed'})
 }finally{await f.close()}
}
// These are byte-for-byte original baseline outputs, not fabricated old flags.
const baseline=process.env.DSS_BASELINE_FIXTURE_ROOT
if(baseline){
 const old=path.join(baseline,'local-normal-relay'),recordRoot=path.join(old,'storage/deepseek_servant/state/retired-workers')
 const names=await fs.readdir(recordRoot),body=await fs.readFile(path.join(recordRoot,names[0],'record.json'),'utf8')
 const envelope=Object.values(JSON.parse(body).tables.records)[0],record=envelope.value
 async function findFile(dir,predicate){for(const item of await fs.readdir(dir,{withFileTypes:true})){const full=path.join(dir,item.name);if(item.isDirectory()){const result=await findFile(full,predicate);if(result)return result}else if(predicate(full))return full}}
 const markerSource=await findFile(path.join(old,'business/technical/worker-transfers'),p=>p.endsWith('/'+record.identity.executionId+'.json'))
 const originalTransfer=JSON.parse(await fs.readFile(markerSource,'utf8'))
 for(const phase of ['stopped','accepted-before-stopped']){
  const f=await fixture('local','legacy-'+phase)
  try{
   await fs.cp(path.join(old,'business'),f.files.directory,{recursive:true});await fs.cp(path.join(old,'sessions'),path.join(f.dir,'sessions'),{recursive:true})
   const owner=phase==='stopped'?record:originalTransfer.record,key=f.prefix+'retired-workers/'+record.identity.executionId
   // The exact baseline transfer's own original pre-stop record supplies the
   // second case; we do not invent stopUnknown or migrate a pending marker.
   await f.records.set(key,owner);await f.records.set(f.prefix+'roles/'+hash(record.identity.workId),originalTransfer.record)
   const {workerTransferPath}=await import('../src/framework/worker-business.ts')
   const marker=workerTransferPath(f.rt.workerBusinessScope(),record.identity.executionId)
   await f.write(marker,JSON.stringify(originalTransfer))
   const native=await findFile(path.join(f.dir,'sessions'),p=>p.includes('/'+record.sessionId+'/')&&p.endsWith('.jsonl')),bytes=await fs.readFile(native)
   f.rt.loop.actions.wake=async()=>false;await f.rt.start();await f.rt.loop.stop();await settle(f.rt)
   check(phase+' old baseline native log unchanged',await fs.readFile(native),bytes)
   check(phase+' old original row not deleted',!!await f.records.get(key),true)
   check(phase+' no native-retirement migration invented',(await f.records.get(key)).nativeRetirements,undefined)
   check(phase+' old transfer preserved',!!await read(f,marker),true)
   rows.push({mode:'local',scenario:'legacy-'+phase,status:'passed',sourceSha256:hash(body),transferSha256:hash(JSON.stringify(originalTransfer))})
  }finally{await f.close()}
 }
}
const result={status:'passed',checks:checks.length,checkNames:checks,rows,trace,...evidence(),limits:'Full production runtime and registered tools. Named persistence failure/ordering boundaries controlled. Legacy cases consume original baseline produced RoleRecord/Worker transfer JSON; the second case is original transfer snapshot before stop, not a newly invented pending fact.'}
await fs.writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))
