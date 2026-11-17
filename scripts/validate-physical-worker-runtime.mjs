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
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { transferPhysicalWorker, resumePhysicalWorkerTransfer } = await import('../src/framework/physical-worker-transfer.ts')
const { workerTransferPath, workerTransferRoot } = await import('../src/framework/worker-business.ts')
const { parseDirectSignal, signalWorkerId, workerPaths } = await import('../src/framework/role-tools.ts')
const { GitAuthorityStore } = await import('../src/framework/git-authority.ts')
const { withSnapshot } = await import('../src/framework/transactions.ts')
const { paths, readJson, assertTaskLifecycle, isTerminalTask } = await import('../src/framework/task-files.ts')
const hash=v=>createHash('sha256').update(v).digest('hex')
const runtimeSource=readFileSync(new URL('framework/role-runtime.ts',sourceRoot),'utf8');loaded.set('framework/role-runtime.ts',hash(runtimeSource));const runtimeJs=stripTypeScriptTypes(runtimeSource,{mode:'transform'})
function method(name){const match=new RegExp('\\n    (?:async )?'+name+'\\(').exec(runtimeJs);assert(match,name);const start=match.index+1,next=/\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(runtimeJs.slice(start+match[0].length));assert(next);return runtimeJs.slice(start,start+match[0].length+next.index)}
const names=['roleKey','physicalSignalSources','reconcileWorkerTransfers','retireWorkerBusiness','workerBusinessScope']
const deps={PhysicalLocalFiles,GitAuthorityStore,withSnapshot,paths,readJson,assertTaskLifecycle,isTerminalTask,workerTransferPath,workerTransferRoot,parseDirectSignal,signalWorkerId,resumePhysicalWorkerTransfer,hash}
const Runtime=new Function(...Object.keys(deps),'return class {\n'+names.map(method).join('\n')+'\n}')(...Object.values(deps))
const root=await fs.mkdtemp(path.join(os.tmpdir(),'dss-worker-runtime-')),files=new PhysicalLocalFiles(root)
let assertions=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++},state=new Map(),gets=[],scans=[]
const records={async get(k){gets.push(k);return structuredClone(state.get(k))},async set(k,v){state.set(k,structuredClone(v))},async list(p){scans.push(p);return[...state].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value:structuredClone(value)}))}}
function runtime(){const r=new Runtime();Object.assign(r,{files,records,prefix:'runtime/',config:{scope:'scope',mode:'local',member:'A'},roleRecords:new Map(),retiredWorkers:new Map(),pending:new Map(),errors:[],detached:[],draining:[],native:{detach(...args){r.detached.push(args)}}});r.drainRetiredWorker=id=>r.draining.push(id);r.error=e=>r.errors.push(e);r.startMaintenance=(key,action)=>{if(r.pending.has(key))return;const p=Promise.resolve().then(action).catch(e=>r.errors.push(e)).finally(()=>r.pending.delete(key));r.pending.set(key,p)};return r}
const read=p=>withSnapshot(files,s=>files.read(s,p))
async function prepare(id,r){const taskId='10000000-0000-4000-8000-'+id.padStart(12,'0'),w=workerPaths(taskId,'A','w'),to=workerPaths(taskId,'A','next'),executionId='execution-'+id,record={identity:{role:'Worker',taskId,member:'A',workerId:'w',executionId,workId:r.roleKey('Worker',taskId,'w')},sessionId:'session-'+id,generation:1},marker=workerTransferPath(r.workerBusinessScope(),executionId),input={commandId:executionId+':call',markerPath:marker,directory:w.root+'/transfer/'+executionId,replyPath:w.reply,reply:'actual reply '+id,notePath:w.notes,records:[],successor:{contractPath:to.contract,contract:'contract '+id,notePath:to.notes,replyPath:to.reply,initialize:true},signalPath:paths.state('A',taskId)+'/Worker_next'}
 await files.replace(paths.task(taskId),JSON.stringify({version:1,taskId,route:'P',owner:'A',members:['A'],status:'running',sourcePath:'tasks/'+id+'.md'}));r.roleRecords.set(record.identity.workId,record)
 const rename=files.rename.bind(files);files.rename=async(a,b)=>{if(b===w.reply)throw Error('accepted before first rename');return rename(a,b)}
 await assert.rejects(transferPhysicalWorker(files,input,async()=>({version:1,record,successorId:'next'}),async()=>{},async()=>[]),/accepted before first rename/);assertions++;files.rename=rename;return{input,record,marker,taskId,w,to}
}
try{
 const r=runtime(),first=await prepare('1',r),second=await prepare('2',r);let entered,release;const ready=new Promise(x=>entered=x),held=new Promise(x=>release=x),rename=files.rename.bind(files)
 files.rename=async(a,b)=>{if(b===first.w.reply){entered();await held}return rename(a,b)}
 await r.reconcileWorkerTransfers(false);await ready
 check(r.roleRecords.get(first.record.identity.workId).businessTransferred,true);check(r.detached.some(x=>x[1]===first.record.identity.executionId),true)
 const secondKey='physical-worker-transfer:'+second.record.identity.executionId;await r.pending.get(secondKey);check(await read(second.input.signalPath),'');check(await read(first.input.signalPath),undefined);check(r.errors.length,0)
 release();await Promise.all([...r.pending.values()]);check(await read(first.input.signalPath),'');check(r.errors.length,0)
 const count=r.detached.length;await r.reconcileWorkerTransfers(false);check(r.pending.size,0);check(r.detached.length>=count,true)
 // Exact saved recipient facts, not a scan or matching path with another inode.
 const signal=second.input.signalPath,version=(await files.fileInfo(signal)).version,recipient=r.roleKey('Worker',second.taskId,'next'),key='runtime/roles/'+hash(recipient)
 state.set(key,{identity:{role:'Worker',workId:recipient},lastWake:{sources:[{path:signal,version}]},notificationClaims:{known:{sources:[{path:signal,version}]}}})
 gets.length=0;scans.length=0;const evidence=await r.physicalSignalSources(signal);check(evidence.length,2);check(gets,[key]);check(scans,[])
 check(await r.physicalSignalSources('state/Other/'+second.taskId+'/Worker_next'),[]);check(await r.physicalSignalSources('state/A/'+second.taskId+'/not-a-role'),[])
 const direct=r.roleKey('Worker',undefined,'chosen','chosen'),directPath='state/Worker_A_Direct_chosen';state.set('runtime/roles/'+hash(direct),{delivery:{request:{sources:[{path:directPath,version}]}}});check((await r.physicalSignalSources(directPath)).length,1)
 // A real signal rename interrupted before the producer saves completion:
 // recipient's existing RoleRecord is saved before its exact signal deletion.
 const third=await prepare('3',r);files.rename=async(a,b)=>{const ok=await rename(a,b);if(b===third.input.signalPath&&ok){const observation=await files.fileInfo(b),workId=r.roleKey('Worker',third.taskId,'next');await records.set('runtime/roles/'+hash(workId),{lastWake:{sources:[{path:b,version:observation.version}]}});await files.deleteObserved(b,observation.version);throw Error('after consumed publication')}return ok}
 await r.reconcileWorkerTransfers(false);await Promise.all([...r.pending.values()]);check(r.errors.at(-1).message,'after consumed publication');check(await read(third.input.signalPath),undefined)
 files.rename=rename;r.errors=[];const cold=runtime();cold.roleRecords=new Map(r.roleRecords);cold.retiredWorkers=new Map(r.retiredWorkers);await cold.reconcileWorkerTransfers(true);await Promise.all([...cold.pending.values()]);check(cold.errors,[]);check(await read(third.input.signalPath),undefined);check(JSON.parse(await read(third.marker)).physical.published,true)
 console.log(JSON.stringify({status:'passed',assertions,sourceHashes:Object.fromEntries(loaded),limits:'Actual Runtime reconciliation/recipient lookup and physical publication. Explicit native drain and technical persistence ports. No desktop Agent factory, Windows or cross-process guarantee.'},null,2))
}finally{await files.close();await fs.rm(root,{recursive:true,force:true});hooks.deregister()}
