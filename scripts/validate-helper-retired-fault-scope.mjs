import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
// Supplementary candidate predecessor boundary: actual installed Helper dss_snapshot/dss_record and physical files. Schema parsing
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
const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {LocalRecordFiles}=await import('../src/framework/local-record-files.ts')
const {installFrameworkRoleTools}=await import('../src/framework/role-tools.ts')
const {resumePhysicalHelperReportsFromEvents,retirePhysicalHelperReportsFromEvents}=await import('../src/framework/physical-helper-report.ts')
const {spawnSync}=await import('node:child_process')
const digest=t=>createHash('sha256').update(t).digest('hex')
const execution='helper-execution',agentId='helper-native-agent',callId='report-call',commandId=execution+':'+callId
const daily='debug/2026-11-09.md',body='Actual Helper findings\r\n实际报告\n',earlier='Earlier actual facts\r\n'
const signal='state/Foreground_Helper_2026-11-09_'+digest(agentId+':'+callId),work='debug/.helper-publications/'+digest(commandId),factPath=work+'/publication.json'
const attempt={actionsTaken:'Checked the original owned operation',outcome:'attempted-not-repaired',result:'Still unconfirmed; retain original responsibility'}
const read=async(f,p)=>{const s=await f.snapshot();try{return await f.read(s,p)}finally{await s.release()}}
async function sources(f){try{return JSON.parse(await fs.readFile(path.join(f.directory,'.test-sources.json'),'utf8'))}catch(e){if(e.code==='ENOENT')return [];throw e}}
async function consume(f,p){const info=await f.fileInfo(p);assert(info);await fs.writeFile(path.join(f.directory,'.test-sources.json'),JSON.stringify([...await sources(f),{path:p,version:info.version}]));await f.deleteObserved(p,info.version)}
async function recordAttempt(f,input,id){const p=path.join(f.directory,'.test-attempts.json');let rows;try{rows=JSON.parse(await fs.readFile(p,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e;rows=[]}const found=rows.find(x=>x.id===id);if(found)assert.deepEqual(found.input,input);else await fs.writeFile(p,JSON.stringify([...rows,{id,input}]))}
const services=f=>({recordAttempt:(input,id)=>recordAttempt(f,input,id),signalSources:()=>sources(f)})
async function eventFile(f,events){await fs.writeFile(path.join(f.directory,'.test-native-events.json'),JSON.stringify(events))}
async function nativeEvents(f){return JSON.parse(await fs.readFile(path.join(f.directory,'.test-native-events.json'),'utf8'))}
async function seed(f){await f.replace(daily,earlier)}
function role(f,{name='Helper',run=execution,record=(i,c)=>recordAttempt(f,i,c),flush=async()=>{},signalSources=()=>sources(f)}={}){
 const tools=new Map(),events=[],callbacks=[],effects=[],errors=[],agent={id:agentId,session:{snapshotEvents:()=>events}}
 const ctx={on:(_n,fn)=>{callbacks.push(fn);return()=>{}},effect:fn=>effects.push(fn()),sessions:{flush},systemPrompt:{section(){}},tools:{register:t=>tools.set(t.name,t)}}
 installFrameworkRoleTools(ctx,agent,{role:name,owner:'A',workId:'helper-work',executionId:run},
  {files:f,physicalSignalSources:signalSources,helper:{recordAttempt:(_binding,i,c)=>record(i,c)},transact:async()=>{throw Error('Unexpected generic transaction')},notifications:async()=>[],claimNotifications:async()=>({signals:[]}),onError:e=>errors.push(e)})
 async function call(name,input,id=name,success=false){events.push({type:'tool/call',data:{name,callId:id,arguments:JSON.stringify(input)}});await eventFile(f,events);const result=await tools.get(name).execute(input,{agent,callId:id,signal:new AbortController().signal,concludeTurn(){}});if(success){const e={type:'tool/result',data:{message:{toolCallId:id,isError:false}}};events.push(e);for(const cb of callbacks)cb(agent.session,e)}return result}
 return {call,events,errors,async dispose(){for(const fn of effects)await fn()}}
}
async function report(f,options={},args={},success=false){const r=role(f,options),v=await r.call('dss_snapshot',{});await r.call('dss_record',{snapshotId:v.snapshotId,path:daily,text:body,append:true,notifyForeground:true,repairAttempt:attempt,...args},callId,success);return r}
const {FrameworkSafetyNet}=await import('../src/framework/safety-net.ts')
const runtimeSource=readFileSync(new URL('framework/role-runtime.ts',sourceRoot),'utf8')
function method(name){const start=runtimeSource.indexOf('  private '+name);assert(start>=0,name);const next=runtimeSource.indexOf('\n  private ',start+4);return runtimeSource.slice(start,next)}
const Scope=new Function('hash','GitAuthorityStore',stripTypeScriptTypes('class Scope {\n'+['async recordSafetyAttempt(','helperTaskOwner(','helperResponsibilities(','safetyFaultFromWake(','updateWake(','rememberAdmissionWake(','forgetAdmissionWake('].map(method).join('\n')+'\n}',{mode:'transform'})+'\nreturn Scope')(digest,class{})
const serviceSource=readFileSync(new URL('framework/service.ts',sourceRoot),'utf8')
function section(start,end){const from=serviceSource.indexOf(start),to=serviceSource.indexOf(end,from+start.length);assert(from>=0&&to>from,start);return serviceSource.slice(from,to)}
const ServiceScope=new Function(stripTypeScriptTypes('class ServiceScope {\n'+[
 section('    private refreshErrors(', '    private sameSafetyFault('),section('    private resolveSafetyFault(', '    private resolveRoleErrors('),section('    private safetyCallbacks(', '    /** One occurrence starts before an RPC.')
].join('\n')+'\n}',{mode:'transform'})+'\nreturn ServiceScope')()
function makeService(){const s=new ServiceScope();s.safetyNet=new FrameworkSafetyNet('current-host');s.reportedErrors=new Map();s.errors=new Map();s.userErrors=new Map();s.resolvedSafetyFaultIds=new Set();s.resolvedRoleFacts=new Set();s.displayOwner='current-host';s.changed=()=>{};s.safetyChanged=()=>{};s.deliverSafetyFaults=()=>{};return s}
let assertions=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++};const rejects=async(fn,re)=>{await assert.rejects(fn,re);assertions++}
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'dss-helper-runtime-'))
const binding={role:'Helper',workId:'helper-work',executionId:execution,owner:'A'}
const wakeId='original-helper-wake',wakeKey='runtime/wakes/'+digest(wakeId)
async function runtime(f,selectedFault,{service=makeService(),hot=false,extraFaults=[]}={}){
 const r=new Scope(),reads=[],sets=[];r.prefix='runtime/';r.config={mode:'local',scope:'original-scope'}
 r.roleRecords=new Map([[binding.workId,{identity:binding,lastWake:{id:wakeId,role:'Helper',taskId:'original-task'}}]])
 r.safetyEpisodes=new Map(hot?[[selectedFault.id,{fault:selectedFault,helperWakeId:wakeId,commands:new Set()}]]:[])
 r.safetyReplayed=new Set();r.resolvedSafetyFaultIds=new Set();r.wakeWrites=new Map();r.wakeWriteOwners=new Map();r.localWakeAdmissions=new Map();r.reportedAdmissionDiagnostics=new Set();r.admissionObservationVersion=0;r.taskRuntimeReleased=async()=>false
 r.environment=service.safetyCallbacks('local')
 r.records={get:async key=>{reads.push(key);return JSON.parse(await read(f,key+'.json')??'null')??undefined},set:async(key,value)=>{sets.push(key);await f.replace(key+'.json',JSON.stringify(value))},delete:async key=>f.delete(key+'.json'),list:async()=>{throw Error('Cold attempt must not scan records')}}
 if(!await read(f,wakeKey+'.json'))await r.records.set(wakeKey,{request:{id:wakeId,role:'Helper',taskId:'original-task',reason:'helper',sources:[]},safetyFaults:[selectedFault,...extraFaults]})
 reads.length=0;sets.length=0
 return {r,reads,sets,service,report:(input,id)=>r.recordSafetyAttempt(binding,input,id)}
}
try{
 const originalFault={id:'actual-fault',taskId:'original-task',mode:'local',scope:'original-scope',source:'owned-operation',message:'Actual original failure',occurrence:1}
 for(const kind of ['unrepaired','repaired','unknown']){
  const f=new PhysicalLocalFiles(path.join(scratch,kind));await seed(f)
  const fault={...originalFault,...(kind==='unknown'?{operationId:'original-UNKNOWN-operation'}:{})}
  const repair={...attempt,outcome:kind==='unrepaired'?'attempted-not-repaired':'repaired'}
  // Actual installed dss_record accepts/publishes the report and explicit
  // signal, then an interruption occurs before its original attempt callback.
  await rejects(()=>report(f,{record:async()=>{throw Error('before actual attempt persistence')}},{repairAttempt:repair}),/status is unconfirmed/)
  await consume(f,signal)
  const cold=await runtime(f,fault);check(cold.r.safetyEpisodes.size,0)
  const events=await nativeEvents(f)
  // Explicit controlled ownership boundary, supplementary to Service/SDK runs:
  // the original report was accepted by the production dss_record tool before
  // its attempt callback failed. New Helper ownership cannot erase its caller.
  const original = {...cold.r.roleRecords.get(binding.workId), sessionId:agentId, generation:1, stopped:true}
  cold.r.roleRecords.set(binding.workId,{identity:{...binding,executionId:'replacement'},sessionId:'replacement-session',generation:2,
    nativeRetirements:[{executionId:execution,sessionId:agentId,helper:{lastWake:original.lastWake}}]})
  const newRequest={id:'new-task-helper-wake',role:'Helper',taskId:'new-task',reason:'helper',sources:[]}
  const newFault={...originalFault,id:'new-task-fault',taskId:'new-task',message:'New task actual fault'}
  const newWake={request:newRequest,delivered:true,signalsConsumed:true,safetyFaults:[newFault]}
  cold.r.taskHelperWakes=new Map()
  cold.r.rememberAdmissionWake(wakeKey,{request:original.lastWake,delivered:true,signalsConsumed:true,safetyFaults:[fault]})
  cold.r.rememberAdmissionWake('runtime/wakes/'+digest(newRequest.id),newWake)
  await cold.r.records.set('runtime/wakes/'+digest(newRequest.id),newWake)
  cold.r.safetyEpisodes.set(newFault.id,{fault:newFault,helperWakeId:newRequest.id,commands:new Set()})
  cold.r.safetyEpisodes.set(fault.id,{fault,helperWakeId:wakeId,commands:new Set()})
  cold.r.environment.safetyReplay(fault,{})
  cold.r.environment.safetyReplay(newFault,{})
  cold.reads.length=0;cold.sets.length=0
  const beforeNew=await read(f,'runtime/wakes/'+digest(newRequest.id)+'.json')
  const beforeEvents=JSON.stringify(events)
  await resumePhysicalHelperReportsFromEvents(f,execution,events,{recordAttempt:(input,id)=>cold.r.recordSafetyAttempt(binding,input,id,original),signalSources:()=>sources(f)},true)
  check(await read(f,factPath),undefined)
  check(JSON.stringify(events),beforeEvents)
  check(events.some(e=>e.type==='tool/result'&&!e.data.message.isError),false)

  check(await read(f,'runtime/wakes/'+digest(newRequest.id)+'.json'),beforeNew);
  check(cold.r.helperResponsibilities(original).some(w=>w.id===newRequest.id),true);
  check(cold.reads,[wakeKey]);check(cold.sets,[wakeKey]);check(await read(f,daily),earlier+body);check(await read(f,signal),undefined)
  const saved=JSON.parse(await read(f,wakeKey+'.json'));check(saved.safetyAttempts.length,1);check(saved.safetyAttempts[0].attemptId,agentId+':'+callId);check(saved.safetyAttempts[0].result,repair.result)
  check(saved.resolvedSafetyFaultIds,kind==='repaired'?[fault.id]:undefined)
  check(cold.r.resolvedSafetyFaultIds.has(fault.id),kind==='repaired')
  if(kind==='unknown'){check(cold.r.safetyEpisodes.get(fault.id).fault.operationId,'original-UNKNOWN-operation');check(cold.service.safetyNet.presentation(fault.id)?.state,'awaiting-outcome');check(cold.service.reportedErrors.get('local').get('safety:'+fault.id).operationId,'original-UNKNOWN-operation')}
  if(kind==='unrepaired')check(cold.service.safetyNet.presentation(fault.id)?.state,'repairing')
  // Same original call is complete; neither source bytes nor accepted attempt
  // are duplicated and no consumed signal is manufactured on another boot.
  const another=await runtime(f,fault);await resumePhysicalHelperReportsFromEvents(f,execution,events,{recordAttempt:another.report,signalSources:()=>sources(f)})
  check(another.reads,[]);check(JSON.parse(await read(f,wakeKey+'.json')).safetyAttempts.length,1);await f.close()
 }
 console.log(JSON.stringify({status:'passed',assertions,limits:'Actual installed report tool and physical publication; extracted production Runtime methods; two task wakes entered through rememberAdmissionWake; controlled replacement and original attempt interruption. Not full Service or live model.',sourceHashes:Object.fromEntries(loaded)},null,2))
}finally{await fs.rm(scratch,{recursive:true,force:true});hooks.deregister()}
