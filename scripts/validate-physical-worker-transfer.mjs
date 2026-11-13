import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
const { PhysicalLocalFiles } = await import(new URL('framework/physical-local-files.ts',sourceRoot))
const { transferPhysicalWorker } = await import(new URL('framework/physical-worker-transfer.ts',sourceRoot))
const { installFrameworkRoleTools, workerPaths } = await import(new URL('framework/role-tools.ts',sourceRoot))
const { workerTransferPath } = await import(new URL('framework/worker-business.ts',sourceRoot))
const { paths } = await import(new URL('framework/task-files.ts',sourceRoot))
const root=process.env.DSS_WORKER_TRANSFER_CHILD ?? await fs.mkdtemp(path.join(os.tmpdir(),'dss-worker-transfer-'))
let assertions=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++};const rejects=async(f,re)=>{await assert.rejects(f,re);assertions++}
const taskId='10000000-0000-4000-8000-000000000001', worker=workerPaths(taskId,'A','w1'),next=workerPaths(taskId,'A','w2')
const marker=workerTransferPath('scope','execution')
const input={commandId:'execution:call',markerPath:marker,directory:worker.root+'/transfer/execution',replyPath:worker.reply,reply:'new reply\n',notePath:worker.notes,records:[{path:worker.records+'facts.md',text:'actual facts'}],handoff:{path:worker.handoff,text:'actual handoff'},successor:{contractPath:next.contract,contract:'next original contract',notePath:next.notes,replyPath:next.reply,initialize:true},signalPath:paths.state('A',taskId)+'/Worker_w2'}
const transfer={version:1,record:{identity:{role:'Worker',workId:'work',executionId:'execution',taskId,member:'A',workerId:'w1'},sessionId:'session',generation:1},successorId:'w2'}
const read=async(files,p)=>{const s=await files.snapshot();try{return await files.read(s,p)}finally{await s.release()}}
async function fixture(name){const files=new PhysicalLocalFiles(path.join(root,name));await files.replace(worker.reply,'old reply\n');await files.replace(worker.notes,'current Note');await files.replace(next.reply,'existing successor reply');return files}
const sources=async(files)=>JSON.parse(await read(files,'accepted-role.json')??'[]')
async function consume(files){const observation=await files.fileInfo(input.signalPath);if(observation){await files.replace('accepted-role.json',JSON.stringify([{path:input.signalPath,version:observation.version}]));await files.deleteObserved(input.signalPath,observation.version)}}
const run=files=>transferPhysicalWorker(files,input,async()=>structuredClone(transfer),async()=>{},()=>sources(files))
if(process.env.DSS_WORKER_TRANSFER_CHILD){
 const phase=process.env.DSS_WORKER_TRANSFER_PHASE,files=await fixture('owned'),rename=files.rename.bind(files),replace=files.replace.bind(files),remove=files.removeDirectory.bind(files)
 const die=()=>process.kill(process.pid,'SIGKILL')
 files.replace=async(p,text)=>{await replace(p,text);if(p===marker){const fact=JSON.parse(text).physical;if(phase==='accepted'&&!fact.files.some(x=>x.published))die();if(phase==='published'&&fact.published)die()}}
 files.rename=async(a,b)=>{const result=await rename(a,b);if(result&&((phase==='reply'&&b===worker.reply)||(phase==='note'&&b===worker.notes)||(phase==='signal'&&b===input.signalPath)))die();if(result&&phase==='consumed'&&b===input.signalPath){await consume(files);die()}return result}
 files.removeDirectory=async(p)=>{await remove(p);if(phase==='removed'&&p===input.directory)die()}
 await run(files);throw Error('Requested real process boundary not reached')
}
try{
 for(const phase of ['accepted','reply','note','signal','consumed','removed','published']){
  const owned=path.join(root,'process-'+phase);await fs.mkdir(owned,{recursive:true})
  const child=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(import.meta.url)],{env:{...process.env,DSS_WORKER_TRANSFER_CHILD:owned,DSS_WORKER_TRANSFER_PHASE:phase},encoding:'utf8'})
  check(child.signal,'SIGKILL')
  const files=new PhysicalLocalFiles(path.join(owned,'owned'));await consume(files);await run(files)
  check(await read(files,worker.reply),'old reply\nnew reply\n');check(await read(files,worker.notes),'');check(await read(files,next.contract),'next original contract');check(await read(files,input.signalPath),(await sources(files)).length?undefined:'')
  check(JSON.parse(await read(files,marker)).physical.published,true);await files.close()
 }
 const trace=await fixture('normal')
 await run(trace);check(await read(trace,worker.reply),'old reply\nnew reply\n');check(await read(trace,worker.notes),'');check(await read(trace,next.reply),'existing successor reply');check(await read(trace,next.contract),'next original contract');check(await read(trace,input.signalPath),'');check(await fs.stat(path.join(trace.directory,input.directory)).then(()=>true,()=>false),false)
 await consume(trace);await trace.replace(worker.reply,'user revised reply');await run(trace);check(await read(trace,worker.reply),'user revised reply');check(await read(trace,input.signalPath),undefined);await trace.close()
 // The installed tool calls this acceptance boundary with exec.signal.
 // An already-aborted native call must not write an accepted transfer marker.
 const aborted=await fixture('abort-before-accept'),cancel=new AbortController()
 cancel.abort(new DOMException('Original tool was cancelled before acceptance.','AbortError'))
 await rejects(()=>transferPhysicalWorker(aborted,input,async()=>structuredClone(transfer),async()=>{},async()=>[],()=>cancel.signal.throwIfAborted()),/cancelled before acceptance/)
 check(await read(aborted,marker),undefined);check(await read(aborted,worker.reply),'old reply\n');check(await read(aborted,input.signalPath),undefined);await aborted.close()
 // Real OS permission denial before the accepted marker, not a method stub.
 // Restrict only this disposable Worker's existing directory. Other platforms
 // and root skip this Linux DAC check; the ordinary/kill cases still run.
 let permissionBeforeAcceptance='skipped: requires Linux non-root DAC',permissionFailure
 if(process.platform==='linux' && typeof process.getuid==='function' && process.getuid()!==0){
  const denied=await fixture('permission-before-accept'),directory=path.join(denied.directory,...worker.root.split('/'))
  const mode=(await fs.stat(directory)).mode & 0o777
  try{
   await fs.chmod(directory,0o500)
   await assert.rejects(()=>run(denied),error=>{permissionFailure={code:error?.code,syscall:error?.syscall};return error?.code==='EACCES'})
   assertions++
  }finally{await fs.chmod(directory,mode)}
  check(await read(denied,marker),undefined)
  check(await read(denied,worker.reply),'old reply\n')
  check(await read(denied,worker.notes),'current Note')
  check(await read(denied,input.signalPath),undefined)
  check(await read(denied,worker.records+'facts.md'),undefined)
  check(await read(denied,next.reply),'existing successor reply')
  check(await fs.stat(path.join(denied.directory,input.directory)).then(()=>true,()=>false),false)
  await run(denied)
  check(JSON.parse(await read(denied,marker)).physical.published,true)
  check(await read(denied,worker.reply),'old reply\nnew reply\n')
  await denied.close()
  permissionBeforeAcceptance='verified: OS EACCES before marker, originals preserved, retry after chmod succeeded'
 }
 // Independent Workers do not queue behind this execution's unfinished I/O.
 const parallel=await fixture('parallel');let arrived,release;const ready=new Promise(r=>arrived=r),hold=new Promise(r=>release=r),replace=parallel.replace.bind(parallel)
 parallel.replace=async(p,v)=>{if(p===input.directory+'/reply.stage'){arrived();await hold}return replace(p,v)}
 const pending=run(parallel);await ready;const second={...input,commandId:'other:call',markerPath:workerTransferPath('scope','other'),directory:worker.root+'/transfer/other',replyPath:worker.root+'/other-reply',notePath:worker.root+'/other-note',records:[],handoff:undefined,successor:undefined,signalPath:'state/A/other/Planner_done'}
 await transferPhysicalWorker(parallel,second,async()=>({...transfer,record:{...transfer.record,identity:{...transfer.record.identity,executionId:'other'}}}),async()=>{},async()=>[]);check(await read(parallel,second.signalPath),'');release();await pending;await parallel.close()
 // Install actual original tools. A generic transaction is an error in this
 // harness, so both normal relay and Planner checkpoint must use real files.
 for(const kind of ['relay','deliver']){
  const files=await fixture('tool-'+kind),tools=new Map(),task={version:1,taskId,route:'P',owner:'A',members:['A'],status:'running',sourcePath:'tasks/input.md'}
  await files.replace(paths.task(taskId),JSON.stringify(task));await files.replace(task.sourcePath,'original task')
  let committed=0,ended=0,notices=[];const binding={...transfer.record.identity,owner:'A',generation:1},agent={id:'native-agent',session:{}},ctx={on:()=>()=>{},effect:()=>{},systemPrompt:{section(){}},tools:{register:t=>tools.set(t.name,t)}}
  installFrameworkRoleTools(ctx,agent,binding,{files,notifications:async()=>notices,claimNotifications:async()=>({signals:[]}),onError(){},transact:async()=>{throw Error('unexpected generic transaction')},physicalSignalSources:()=>sources(files),workerBusiness:{transferPath:()=>marker,assertLive(){},async assert(){},async transfer(_b,_s,id,role){return[{path:marker,content:JSON.stringify({...transfer,successorId:id,...role?{successorRole:role}:{}})}]},async committed(){committed++}}})
  const exec={agent,callId:'snapshot',signal:new AbortController().signal,concludeTurn:()=>ended++},view=await tools.get('dss_snapshot').execute({},exec),tool=tools.get('dss_worker_'+kind)
  const payload={snapshotId:view.snapshotId,reply:'tool reply',records:[{path:worker.records+'tool.md',text:'tool actual'}],handoff:'tool handoff',...(kind==='relay'?{successorId:'w2',contract:'tool contract'}:{})}
  notices=['state/A/'+taskId+'/Worker_new'];const continuation=await tool.execute(payload,{...exec,callId:'blocked'});check(committed,0);check(ended,0);check(await read(files,marker),undefined);check(JSON.stringify(continuation).includes('Worker_new'),true)
  notices=[];await tool.execute(payload,{...exec,callId:'deliver'});check(committed,1);check(ended,1);check(await read(files,worker.reply),'old reply\ntool reply');check(await read(files,worker.notes),'')
  const signal=kind==='relay'?input.signalPath:paths.state('A',taskId)+'/Planner_w1-Worker-G1';check(await read(files,signal),'');check(await read(files,worker.records+'tool.md'),'tool actual')
  await files.delete(signal);await tool.execute(payload,{...exec,callId:'deliver'});check(await read(files,signal),undefined);check(await read(files,worker.reply),'old reply\ntool reply');await files.close()
 }
 console.log(JSON.stringify({status:'passed',assertions,realProcessExits:7,permissionBeforeAcceptance,...permissionFailure?{permissionFailure}:{},sourceHashes:Object.fromEntries(loaded),limits:'Actual installed Worker tools and physical files, normal transfer/replay and seven actual SIGKILL process boundaries. Already-aborted AbortController covers the existing acceptance signal. Linux non-root real directory permissions, when supported, cover a pre-acceptance EACCES and retry; no post-acceptance permission failure is claimed. Unverified stage loss and synthetic generic method before/after errors are not included in this production-entry regression. Native execution and runtime reconciliation still require their separate integration checks; no Windows/full build or cross-process exclusion claim.'},null,2))
}finally{await fs.rm(root,{recursive:true,force:true});hooks.deregister()}
