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
const sourceRoot=new URL('../src/',import.meta.url),legacyRoot=new URL('./test-support/historical-7109/',import.meta.url),loaded=new Map()
const data=text=>'data:text/javascript;base64,'+Buffer.from(text).toString('base64')
const hooks=registerHooks({resolve(specifier,context,next){
 if(specifier==='zod')return{url:data(`const z=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;if(k==='toJSONSchema')return ()=>({});return z},apply(){return z}});export {z}`),shortCircuit:true}
 if(specifier==='mdast-util-from-markdown')return{url:data(`export function fromMarkdown(){throw new Error('Markdown outside this test')}`),shortCircuit:true}
 if(specifier.startsWith('.')&&(context.parentURL?.startsWith(sourceRoot.href)||context.parentURL?.startsWith(legacyRoot.href))&&specifier.endsWith('.js')){
 const parent=context.parentURL.startsWith(legacyRoot.href)?new URL('framework/',sourceRoot):context.parentURL
 const url=new URL(specifier.slice(0,-3)+'.ts',parent)
 if(url.href===new URL('framework/skills.ts',sourceRoot).href)return{url:data(`export const frameworkSkillIndexPath='skills/index.md';export function isFrameworkSkillDefinitionPath(){throw new Error('Skill definition outside this test')}export function prepareFrameworkSkillIndex(){throw new Error('Skills outside this test')}`),shortCircuit:true}
 if(existsSync(fileURLToPath(url)))return{url:url.href,shortCircuit:true}}
 return next(specifier,context)},load(url,context,next){if((url.startsWith(sourceRoot.href)||url.startsWith(legacyRoot.href))&&url.endsWith('.ts')){const source=readFileSync(new URL(url),'utf8');loaded.set(url.startsWith(legacyRoot.href)?'historical-7109/'+url.slice(legacyRoot.href.length):url.slice(sourceRoot.href.length),createHash('sha256').update(source).digest('hex'));return{format:'module',source:stripTypeScriptTypes(source,{mode:'transform',sourceUrl:url}),shortCircuit:true}}return next(url,context)}})
const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {FrameworkHostLoop}=await import('../src/framework/host-loop.ts')
const {FrameworkTransactions}=await import('../src/framework/command-transactions.ts')
const {resumePhysicalDirectDelivery,retirePublishedDirectDelivery,deliverPhysicalDirect}=await import('../src/framework/physical-direct-delivery.ts')
const {parseDirectSignal,signalWorkerId,installFrameworkRoleTools}=await import('../src/framework/role-tools.ts')
const {withSnapshot,withOperationChannel}=await import('../src/framework/transactions.ts')
const {paths,readJson}=await import('../src/framework/task-files.ts')
const {GitAuthorityStore}=await import('../src/framework/git-authority.ts')
const {scanMemberRecovery}=await import('../src/framework/recovery.ts')
const {randomUUID}=await import('node:crypto')
const {spawnSync}=await import('node:child_process')
const source=readFileSync(new URL('../src/framework/role-runtime.ts',import.meta.url),'utf8'),js=stripTypeScriptTypes(source,{mode:'transform'})
loaded.set('framework/role-runtime.ts',createHash('sha256').update(source).digest('hex'))
function method(name){const m=new RegExp('\n    (?:async )?'+name+'\\(').exec(js);assert(m,name);const start=m.index+1,next=/\n    (?:async )?[A-Za-z_$][^\n]*(?:\(|=)/.exec(js.slice(start+m[0].length));assert(next,name);return js.slice(start,start+m[0].length+next.index)}
class Sessions{constructor(ctx){this.ctx=ctx}async inspect(id){return this.ctx.inspections.get(id)??{exists:false}}async events(id){return this.ctx.events.get(id)??[]}}
const hash=v=>createHash('sha256').update(v).digest('hex')
const deps={PhysicalLocalFiles,GitAuthorityStore,withSnapshot,withOperationChannel,paths,readJson,scanMemberRecovery,randomUUID,parseDirectSignal,signalWorkerId,hash,DshSessionReader:Sessions,resumePhysicalDirectDelivery,retirePublishedDirectDelivery}
const Runtime=new Function(...Object.keys(deps),'return class {\n'+['services','saveRole','saveRoleInChannel','taskRuntimeReleased','continueNativeRetirements','physicalDirectInput','settlePhysicalDirectDelivery','physicalSignalSources','roleKey','startMaintenance','currentTask','startup','startupRecovery','beforeTaskUse'].map(method).join('\n')+'\n}')(...Object.values(deps))
const scratch=['--settle-interrupt','--legacy-result-renamed'].includes(process.argv[2])?undefined:await fs.mkdtemp(path.join(os.tmpdir(),'dss-direct-runtime-'))
let assertions=0,processInterruptions=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
const read=(f,p)=>withSnapshot(f,s=>f.read(s,p))
const text='第三方原结果\r\n完整保留',input='direct/external.md',output='results/third-party-choice.md',signal='state/Foreground_external-result'
const fact='direct/external/.delivery/publication.json',original='state/Worker_A_Direct_external'
const directRecord=(rt,id='external')=>({identity:{role:'Worker',workerId:id,workId:rt.roleKey('Worker',undefined,id,id),executionId:'direct-execution'+(id==='external'?'':'-'+id)},sessionId:'session-'+id,generation:1,stopped:true,lastWake:{id:'wake-'+id,role:'Worker',workerId:id,reason:'notification',sources:[{path:'state/Worker_A_Direct_'+id,version:'original-source'}]}})
function setup(files){
 const values=new Map(),reads=[],arranged=[],errors=[],storage={get:async k=>{reads.push(k);return structuredClone(values.get(k))},set:async(k,v)=>{await fs.mkdir(files.directory,{recursive:true});if(v?.identity?.workerId==='external')await fs.writeFile(path.join(files.directory,'.test-source-role.json'),JSON.stringify(v));values.set(k,structuredClone(v))},list:async()=>{throw Error('No new role or publication scan')}}
 const rt=Object.assign(new Runtime(),{files,records:storage,prefix:'runtime/',config:{member:'A',mode:'local'},closed:false,roleRecords:new Map(),roleWriteOwners:new Map(),ctx:{inspections:new Map(),events:new Map()},environment:{},conversation:{foregroundRoot:'foreground'},startSafetyResolutionLoad(){},processObservations:async()=>{},readStartupRecoveryFacts:async()=>({restoring:new Set(),recovered:new Set()}),scanMembers:async()=>[],diagnoseMissingTask:async()=>false,memberContinuationEligible:async()=>true,active:()=>false,controls:{execution:async()=>false},error:(e,c)=>errors.push({e,stage:c?.stage}),startOwnedPump(){},arrangeNativeContinuation:async r=>{arranged.push(r.identity.workId)}})
 return {rt,values,reads,arranged,errors,storage,async add(record){rt.roleRecords.set(record.identity.workId,record);values.set('runtime/roles/'+hash(record.identity.workId),structuredClone(record))}}
}
async function startHost(f,r){const loop=new FrameworkHostLoop(f,new FrameworkTransactions(f,r.storage,'direct-startup'),r.storage,{member:'A',primary:true,scope:'direct-startup',instanceUUID:'10000000-0000-4000-8000-000000000001'},()=>['A'],{startup:()=>r.rt.startup(),observe:async()=>{},executing:()=>false,wake:async()=>false,error:e=>r.errors.push({e,stage:'host'})});await loop.start();await loop.firstPoll;return loop}
async function drain(rt){for(let n=0;n<50;n++){const jobs=[...rt.maintenance?.values()??[]];if(!jobs.length)return;await Promise.all(jobs)}throw Error('Startup maintenance did not settle')}
if(process.argv[2]==='--settle-interrupt'){
 const dir=process.argv[3],mode=process.argv[4],f=new PhysicalLocalFiles(dir),r=setup(f),record=directRecord(r.rt),exit=()=>process.exit(83)
 await r.add(record);await fs.writeFile(path.join(dir,'.test-source-role.json'),JSON.stringify(record))
 await f.replace(input,'Original third-party input')
 const publication=await deliverPhysicalDirect(f,{commandId:'direct-execution:deliver',inputPath:input,resultPath:output,recipientSignal:signal,text},()=>{})
 const observed=await f.fileInfo(signal);await fs.writeFile(path.join(dir,'.test-receiver-sources.json'),JSON.stringify([{path:signal,version:observed.version}]));await f.deleteObserved(signal,observed.version)
 const save=r.rt.saveRole.bind(r.rt);r.rt.saveRole=async value=>{if(mode==='before-save')exit();await save(value);if(mode==='after-save')exit()}
 const del=f.delete.bind(f),empty=f.removeEmptyDirectory.bind(f)
 f.delete=async p=>{if(mode==='before-retire'&&p===fact.replace('/publication.json','/result.stage'))exit();const value=await del(p);if(mode==='after-fact-delete'&&p===fact)exit();return value}
 f.removeEmptyDirectory=async p=>{const value=await empty(p);if(mode==='after-directory-retire')exit();return value}
 await r.rt.settlePhysicalDirectDelivery(record,input,publication.commandId);throw Error('Expected settlement process interruption not reached')
}
if(process.argv[2]==='--legacy-result-renamed'){
 const historical=new URL('./test-support/historical-7109/physical-direct-delivery.ts',import.meta.url)
 check(hash(readFileSync(historical)),'0f4ced3830cb9cbef47b96a762a8cdc7699045ebef530fa1e39deadd9a116c1b')
 const {deliverPhysicalDirect:legacyDeliver}=await import(historical.href)
 const f=new PhysicalLocalFiles(process.argv[3]),rename=f.rename.bind(f)
 f.rename=async(a,b)=>{const value=await rename(a,b);if(b===output)process.exit(84);return value}
 await legacyDeliver(f,{commandId:'direct-execution:deliver',inputPath:input,resultPath:output,recipientSignal:signal,text},()=>{})
 throw Error('Expected historical result rename interruption not reached')
}
try{
 for(const phase of ['before-acceptance','accepted','result-prepared','result-renamed','signal-prepared','signal-renamed','signal-consumed','published']){
  const dir=path.join(scratch,phase);let f=new PhysicalLocalFiles(dir);await f.replace(input,'Original third-party input');await f.replace(output,'Earlier designated output');await f.close()
  const child=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(new URL('./validate-physical-direct-delivery.mjs',import.meta.url)),'--interrupt',dir,phase],{encoding:'utf8',timeout:30000});check(child.status,81);if(child.status!==81)throw Error(child.stderr);processInterruptions++
  f=new PhysicalLocalFiles(dir);const r=setup(f),record=directRecord(r.rt);await r.add(record)
  if(phase==='signal-consumed'){
   const saved=JSON.parse(await fs.readFile(path.join(dir,'.test-receiver-sources.json'),'utf8')),key=r.rt.roleKey('Foreground')
   await r.add({identity:{role:'Foreground',workId:key,executionId:'recipient-exec'},sessionId:'recipient-session',generation:1,stopped:true,completedRound:true,lastWake:{id:'recipient-wake',role:'Foreground',sources:saved}})
  }
  const host=await startHost(f,r);await drain(r.rt);check(r.errors.map(e=>e.e.message),[]);check(r.arranged.includes(record.identity.workId),phase==='before-acceptance')
  if(phase==='before-acceptance'){check(await read(f,fact),undefined);check(await read(f,output),'Earlier designated output')}
  else{check(await read(f,fact),undefined);check(r.rt.roleRecords.get(record.identity.workId).gitSettledWakeId,record.lastWake.id);check(await read(f,output),text);check(await read(f,signal),phase==='signal-consumed'?undefined:'')}
  await host.stop();await f.close()
 }
 // A real result-stage rename, then process exit before resultPublished is
 // saved. The designated output is user-visible; an ordinary external append
 // edits that same inode while the Host is down. Cold Host startup, not native
 // tool replay, must settle the old source and keep the user's later bytes.
 {
  const dir=path.join(scratch,'result-renamed-user-edited');let f=new PhysicalLocalFiles(dir)
  await f.replace(input,'Original third-party input');await f.replace(output,'Earlier designated output');await f.close()
  const child=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(new URL('./validate-physical-direct-delivery.mjs',import.meta.url)),'--interrupt',dir,'result-renamed'],{encoding:'utf8',timeout:30000})
  check(child.status,81);if(child.status!==81)throw Error(child.stderr);processInterruptions++
  f=new PhysicalLocalFiles(dir)
  const before=await f.fileInfo(output),accepted=JSON.parse(await read(f,fact))
  check(accepted.resultPrepared,true);check(accepted.resultPublished,undefined)
  check(await f.fileInfo('direct/external/.delivery/result.stage'),undefined)
  await fs.appendFile(path.join(dir,output),'\nUser edit while Host offline')
  const after=await f.fileInfo(output)
  const identity=v=>/^local-file:(\d+):(\d+):\d+:-?\d+:-?\d+:(-?\d+)$/.exec(v)?.slice(1).join(':')
  check(identity(before.version),identity(after.version));check(await read(f,output),text+'\nUser edit while Host offline')
  const r=setup(f),record=directRecord(r.rt);await r.add(record)
  const host=await startHost(f,r);await drain(r.rt)
  check(r.errors.map(e=>e.e.message),[])
  check(r.rt.roleRecords.get(record.identity.workId).gitSettledWakeId,record.lastWake.id)
  check(await read(f,output),text+'\nUser edit while Host offline');check(await read(f,signal),'')
  check(await read(f,fact),undefined);check(await read(f,input),'Original third-party input')
  await host.stop();await f.close()
 }
 // Frozen 710939e producer creates a genuine accepted fact without the new
 // field, then actually renames and exits. Exact old bytes still resume under
 // the original SHA rule; the candidate must not strand this in-flight work.
 for(const changed of [false,true]){
  const dir=path.join(scratch,changed?'legacy-renamed-user-edited':'legacy-renamed-unchanged');let f=new PhysicalLocalFiles(dir)
  await f.replace(input,'Original third-party input');await f.replace(output,'Earlier designated output');await f.close()
  const child=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(import.meta.url),'--legacy-result-renamed',dir],{encoding:'utf8',timeout:30000})
  check(child.status,84);if(child.status!==84)throw Error(child.stderr);processInterruptions++
  f=new PhysicalLocalFiles(dir);const accepted=JSON.parse(await read(f,fact))
  check(accepted.resultPrepared,true);check(accepted.resultPublished,undefined)
  check('resultStageVersion' in accepted,false);check(await f.fileInfo('direct/external/.delivery/result.stage'),undefined)
  check(await read(f,output),text)
  if(changed)await fs.appendFile(path.join(dir,output),'\nLegacy offline edit')
  const r=setup(f),record=directRecord(r.rt);await r.add(record)
  const host=await startHost(f,r);await drain(r.rt)
  if(changed){
   check(r.errors.some(x=>/publication cannot be established/.test(x.e.message)),true)
   check(r.rt.roleRecords.get(record.identity.workId).gitSettledWakeId,undefined)
   check(await read(f,fact)!==undefined,true);check(await read(f,signal),undefined)
   check(await read(f,output),text+'\nLegacy offline edit')
  }else{
   check(r.errors.map(x=>x.e.message),[])
   check(r.rt.roleRecords.get(record.identity.workId).gitSettledWakeId,record.lastWake.id)
   check(await read(f,fact),undefined);check(await read(f,signal),'');check(await read(f,output),text)
  }
  check(await read(f,input),'Original third-party input')
  await host.stop();await f.close()
 }
 // In contrast, a user-deleted target has no file identity proof. Do not
 // notify or settle that unknown old publication, and do not restore bytes.
 {
  const dir=path.join(scratch,'result-renamed-user-deleted');let f=new PhysicalLocalFiles(dir)
  await f.replace(input,'Original third-party input');await f.replace(output,'Earlier designated output');await f.close()
  const child=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(new URL('./validate-physical-direct-delivery.mjs',import.meta.url)),'--interrupt',dir,'result-renamed'],{encoding:'utf8',timeout:30000})
  check(child.status,81);if(child.status!==81)throw Error(child.stderr);processInterruptions++
  await fs.unlink(path.join(dir,output));f=new PhysicalLocalFiles(dir)
  const r=setup(f),record=directRecord(r.rt);await r.add(record)
  const host=await startHost(f,r);await drain(r.rt)
  check(r.errors.some(x=>/publication cannot be established/.test(x.e.message)),true)
  check(r.rt.roleRecords.get(record.identity.workId).gitSettledWakeId,undefined)
  check(await read(f,output),undefined);check(await read(f,signal),undefined)
  check(!!await read(f,fact),true);check(await read(f,input),'Original third-party input')
  await host.stop();await f.close()
 }
 // Atomic replacement with a different inode is similarly unconfirmed even
 // when the user keeps a same-name output at the designated path.
 for(const replacement of ['User replacement',text]){
  const dir=path.join(scratch,replacement===text?'result-renamed-user-replaced-same-bytes':'result-renamed-user-replaced');let f=new PhysicalLocalFiles(dir)
  await f.replace(input,'Original third-party input');await f.replace(output,'Earlier designated output');await f.close()
  const child=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(new URL('./validate-physical-direct-delivery.mjs',import.meta.url)),'--interrupt',dir,'result-renamed'],{encoding:'utf8',timeout:30000})
  check(child.status,81);if(child.status!==81)throw Error(child.stderr);processInterruptions++
  f=new PhysicalLocalFiles(dir);const before=await f.fileInfo(output)
  await fs.writeFile(path.join(dir,'user-replacement.tmp'),replacement)
  await fs.rename(path.join(dir,'user-replacement.tmp'),path.join(dir,output))
  const after=await f.fileInfo(output),identity=v=>/^local-file:(\d+):(\d+):\d+:-?\d+:-?\d+:(-?\d+)$/.exec(v)?.slice(1).join(':')
  check(identity(before.version)===identity(after.version),false)
  const r=setup(f),record=directRecord(r.rt);await r.add(record)
  const host=await startHost(f,r);await drain(r.rt)
  check(r.errors.some(x=>/publication cannot be established/.test(x.e.message)),true)
  check(r.rt.roleRecords.get(record.identity.workId).gitSettledWakeId,undefined)
  check(await read(f,output),replacement);check(await read(f,signal),undefined)
  check(!!await read(f,fact),true);check(await read(f,input),'Original third-party input')
  await host.stop();await f.close()
 }
 // Real source settlement before/after durable save and technical deletion.
 // The original recipient has already consumed its signal. No native result
 // is needed to invent another completion or replay this delivery.
 for(const phase of ['before-save','after-save','before-retire','after-fact-delete','after-directory-retire']){
  const dir=path.join(scratch,'settlement-'+phase);await fs.mkdir(dir,{recursive:true})
  const child=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(import.meta.url),'--settle-interrupt',dir,phase],{encoding:'utf8',timeout:30000});check(child.status,83);if(child.status!==83)throw Error(child.stderr);processInterruptions++
  const f=new PhysicalLocalFiles(dir),r=setup(f),record=JSON.parse(await fs.readFile(path.join(dir,'.test-source-role.json'),'utf8'));await r.add(record)
  const saved=JSON.parse(await fs.readFile(path.join(dir,'.test-receiver-sources.json'),'utf8')),key=r.rt.roleKey('Foreground')
  await r.add({identity:{role:'Foreground',workId:key,executionId:'recipient'},sessionId:'recipient',generation:1,stopped:true,completedRound:true,lastWake:{id:'recipient-wake',role:'Foreground',sources:saved}})
  const host=await startHost(f,r);await drain(r.rt);check(r.errors.map(e=>e.e.message),[])
  check(r.arranged,[]);check(r.rt.roleRecords.get(record.identity.workId).gitSettledWakeId,record.lastWake.id)
  check(await read(f,fact),undefined);check(await read(f,signal),undefined);check(await read(f,output),text);check(await read(f,input),'Original third-party input')
  check(existsSync(path.join(dir,'direct/external/.delivery')),false);check(existsSync(path.join(dir,'direct/external')),false)
  await host.stop();await f.close()
 }

 // Actual runtime service closures -> installed tool -> actual settlement.
 // Repeat the identical call before any native tool/result is persisted. The
 // original completed source responsibility prevents a second publication.
 const live=new PhysicalLocalFiles(path.join(scratch,'live-service')),liveRuntime=setup(live),sourceRecord={...directRecord(liveRuntime.rt),stopped:false};await liveRuntime.add(sourceRecord)
 await live.replace(input,'Original third-party input')
 const service=liveRuntime.rt.services(),tools=new Map(),agent={id:'native-agent',session:{}},ctx={on:()=>()=>{},effect:()=>{},systemPrompt:{section(){}},tools:{register:t=>tools.set(t.name,t)}}
 const binding={...sourceRecord.identity,owner:'A',direct:{inputPath:input,signalPath:original}}
 installFrameworkRoleTools(ctx,agent,binding,{files:live,physicalSignalSources:service.physicalSignalSources,directDeliverySettled:service.directDeliverySettled,directDelivered:service.directDelivered,transact:async()=>{throw Error('Generic direct transaction')},notifications:async()=>[],claimNotifications:async()=>({signals:[]}),onError:e=>{throw e}})
 const exec={agent,callId:'original-call',signal:new AbortController().signal,concludeTurn(){}}
 const view=await tools.get('dss_snapshot').execute({},exec),args={snapshotId:view.snapshotId,text,resultPath:output,recipientSignal:signal}
 await tools.get('dss_direct_deliver').execute(args,exec)
 check(liveRuntime.rt.roleRecords.get(binding.workId).gitSettledWakeId,sourceRecord.lastWake.id);check(await read(live,fact),undefined)
 const notice=await live.fileInfo(signal);await live.deleteObserved(signal,notice.version);await live.append(output,'\nUser edit')
 await tools.get('dss_direct_deliver').execute(args,exec)
 check(await read(live,signal),undefined);check(await read(live,output),text+'\nUser edit');check(await read(live,fact),undefined)
 liveRuntime.rt.roleRecords.set(binding.workId,{...liveRuntime.rt.roleRecords.get(binding.workId),identity:{...binding,executionId:'replacement'}})
 await assert.rejects(tools.get('dss_direct_deliver').execute(args,exec),/replaced execution/);assertions++
 await live.close()

 // Real Runtime precise lookup reads only the addressed existing recipient
 // role. Same-name source values come from that record, not a directory scan.
 const f=new PhysicalLocalFiles(path.join(scratch,'lookup')),r=setup(f),fg=r.rt.roleKey('Foreground'),src={path:signal,version:'actual-observed-version'}
 await r.add({identity:{role:'Foreground',workId:fg,executionId:'fg'},lastWake:{sources:[src,{path:'state/Foreground_other',version:'other'}]}})
 check(await r.rt.physicalSignalSources(signal),[src]);check(r.reads,['runtime/roles/'+hash(fg)])
 check(await r.rt.physicalSignalSources('state/B/task/Planner_Worker'),[]);check(r.reads.length,1)
 const workerKey=r.rt.roleKey('Worker',undefined,'external','external');await r.add({identity:{role:'Worker',workId:workerKey,executionId:'worker'},notificationClaims:{c:{sources:[{path:original,version:'direct-source'}]}}})
 check(await r.rt.physicalSignalSources(original),[{path:original,version:'direct-source'}]);check(r.reads.at(-1),'runtime/roles/'+hash(workerKey))
 await f.close()
 // One direct startup lane is slow. Other direct, Foreground and Helper
 // records continue; repeating startup does not duplicate the held lane.
 const g=new PhysicalLocalFiles(path.join(scratch,'parallel')),p=setup(g)
 for(const id of ['external','other']){await p.add(directRecord(p.rt,id));const replace=g.replace.bind(g);g.replace=async(a,b)=>{await replace(a,b);if(a==='direct/'+id+'/.delivery/publication.json'&&!JSON.parse(b).resultPrepared)throw Error('accepted')};await assert.rejects(deliverPhysicalDirect(g,{commandId:id,inputPath:'direct/'+id+'.md',resultPath:'results/'+id+'.md',recipientSignal:'state/Foreground_'+id,text:id},()=>{}),/accepted/);g.replace=replace}
 for(const name of ['Foreground','Helper'])await p.add({identity:{role:name,workId:p.rt.roleKey(name),executionId:name},sessionId:name,generation:1,stopped:true,lastWake:{id:'wake-'+name,role:name,sources:[]}})
 let release,entered,renames=0;const held=new Promise(r=>release=r),ready=new Promise(r=>entered=r),rename=g.rename.bind(g)
 g.rename=async(a,b)=>{if(b==='results/external.md'){renames++;entered();await held}return rename(a,b)}
 const host=await startHost(g,p);await ready;await p.rt.startupRecovery({facts:{restoring:new Set(),recovered:new Set()}})
 for(let n=0;n<200&&!p.rt.roleRecords.get(p.rt.roleKey('Worker',undefined,'other','other')).gitSettledWakeId;n++)await new Promise(r=>setTimeout(r,2))
 check(await read(g,'results/other.md'),'other');check(p.arranged.includes(p.rt.roleKey('Foreground')),true);check(p.arranged.includes(p.rt.roleKey('Helper')),true);check(renames,1)
 const before=[...p.arranged];await p.rt.startupRecovery({taskId:'unrelated-selected-task',facts:{restoring:new Set(),recovered:new Set()}});check(p.arranged,before)
 release();await drain(p.rt);check(p.errors.map(e=>e.e.message),[]);await host.stop();await g.close()
 console.log(JSON.stringify({status:'passed',assertions,processInterruptions,limits:'Actual Host.start and Runtime startup/startupRecovery/startMaintenance/saveRole/source-settlement/direct lookup methods with physical module/files after Linux process exit; controlled preloaded source RoleRecords, native session reader/continuation factory, unrelated Task discovery and receiver persistence boundary. No real DSH or full repository typecheck; source RoleRecord completion and retirement process windows verified; native shutdown/DSH session lifecycle remain separate and unclaimed.',sourceHashes:Object.fromEntries(loaded)},null,2))
}finally{await fs.rm(scratch,{recursive:true,force:true});hooks.deregister()}
