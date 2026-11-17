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
const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {installFrameworkRoleTools}=await import('../src/framework/role-tools.ts')
const {resumePhysicalDirectDelivery,retirePublishedDirectDelivery}=await import('../src/framework/physical-direct-delivery.ts')
const {spawnSync}=await import('node:child_process')
const scratch=process.argv[2]==='--interrupt'?undefined:await fs.mkdtemp(path.join(os.tmpdir(),'dss-direct-deliver-'))
let assertions=0,processInterruptions=0,interruptedOperations=0
const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
const rejects=async(fn,re)=>{await assert.rejects(fn,re);assertions++}
const read=async(files,p)=>{const s=await files.snapshot();try{return await files.read(s,p)}finally{await s.release()}}
const inputPath='direct/external.md',signal='state/Foreground_external-result',output='results/third-party-choice.md',text='第三方原结果\r\n完整保留',work='direct/external/.delivery',factPath=work+'/publication.json'
async function sources(files){try{return JSON.parse(await fs.readFile(path.join(files.directory,'.test-receiver-sources.json'),'utf8'))}catch(e){if(e.code==='ENOENT')return [];throw e}}
async function consume(files,p){const info=await files.fileInfo(p);assert(info);const before=await sources(files);await fs.writeFile(path.join(files.directory,'.test-receiver-sources.json'),JSON.stringify([...before,{path:p,version:info.version}]));await files.deleteObserved(p,info.version)}
async function seed(files){await files.replace(inputPath,'Original third-party input');await files.replace('direct/external/takeover.md','Existing takeover');await files.replace(output,'Earlier designated output')}
function role(files,{name='Worker',execution='direct-execution',flush=async()=>{},pending=[],selectedInput=inputPath,settle,settled}={}){
 const tools=new Map(),events=[],callbacks=[],effects=[],errors=[],agent={id:'not-execution-id',session:{snapshotEvents:()=>events}}
 const ctx={on:(_n,fn)=>{callbacks.push(fn);return()=>{}},effect:fn=>effects.push(fn()),sessions:{flush},systemPrompt:{section(){}},tools:{register:t=>tools.set(t.name,t)}}
 const binding={role:name,owner:'A',workId:'direct-'+name+'-'+selectedInput,executionId:execution,direct:{inputPath:selectedInput,signalPath:'state/'+name+'_A_Direct_external'}}
 let ended=0
 installFrameworkRoleTools(ctx,agent,binding,{files,physicalSignalSources:()=>sources(files),directDelivered:settle,directDeliverySettled:settled,transact:async()=>{throw Error('Direct Local delivery must not use generic transaction')},notifications:async()=>pending,claimNotifications:async()=>({signals:[]}),onError:e=>errors.push(e)})
 async function call(name,input,callId=name,success=false){events.push({type:'tool/call',data:{name,callId,arguments:JSON.stringify(input)}});const result=await tools.get(name).execute(input,{agent,callId,signal:new AbortController().signal,concludeTurn(){ended++}});if(success){const e={type:'tool/result',data:{message:{toolCallId:callId,isError:false}}};events.push(e);for(const cb of callbacks)cb(agent.session,e)}return result}
 return {call,events,errors,get ended(){return ended},async dispose(){for(const d of effects)await d()}}
}
async function deliver(files,options={},success=false,args={}){const r=role(files,options),view=await r.call('dss_snapshot',{});await r.call('dss_direct_deliver',{snapshotId:view.snapshotId,text,resultPath:output,recipientSignal:signal,...args},'deliver',success);return r}
if(process.argv[2]==='--interrupt'){
 const files=new PhysicalLocalFiles(process.argv[3]),mode=process.argv[4],replace=files.replace.bind(files),rename=files.rename.bind(files),exit=()=>process.exit(81)
 files.replace=async(p,v)=>{if(mode==='before-acceptance'&&p===factPath)exit();await replace(p,v);if(p===factPath){const f=JSON.parse(v);if(mode==='accepted'&&!f.resultPrepared)exit();if(mode==='result-prepared'&&f.resultPrepared&&!f.resultPublished)exit();if(mode==='signal-prepared'&&f.signalVersion&&!f.published)exit();if(mode==='published'&&f.published)exit()}}
 files.rename=async(a,b)=>{const r=await rename(a,b);if(mode==='result-renamed'&&b===output)exit();if((mode==='signal-renamed'||mode==='signal-consumed')&&b===signal){if(mode==='signal-consumed')await consume(files,b);exit()}return r}
 await deliver(files);throw Error('Expected direct exit boundary not reached')
}
try{
 // Real P/W tools publish result before the original recipient notification.
 for(const name of ['Planner','Worker']){
  const f=new PhysicalLocalFiles(path.join(scratch,name));await seed(f);const order=[],rename=f.rename.bind(f)
  f.rename=async(a,b)=>{order.push(b);if(b===signal)check(await read(f,output),text);return rename(a,b)}
  const r=await deliver(f,{name});check(r.ended,1);check(order,[output,signal]);check(await read(f,inputPath),'Original third-party input');check(await read(f,'direct/external/takeover.md'),'Existing takeover')
  await consume(f,signal);await f.append(output,'\nUser edit');await deliver(f,{name});check(await read(f,output),text+'\nUser edit');check(await read(f,signal),undefined)
  await rejects(()=>deliver(f,{name},false,{text:'Changed same direct result'}),/original result and recipient/)
  check(JSON.parse(await read(f,factPath)).resultText,undefined)
  await f.close()
 }
 // Failure around each real filesystem write boundary and same-command retry.
 const trace=new PhysicalLocalFiles(path.join(scratch,'trace'));await seed(trace);let count=0
 for(const key of ['replace','rename']){const original=trace[key].bind(trace);trace[key]=async(...a)=>{count++;return original(...a)}}
 await deliver(trace);await trace.close()
 for(const when of ['before','after'])for(let at=0;at<count;at++){
  let f=new PhysicalLocalFiles(path.join(scratch,when+'-'+at));await seed(f);let n=0
  for(const key of ['replace','rename']){const original=f[key].bind(f);f[key]=async(...a)=>{const x=n++;if(x===at&&when==='before')throw Error('direct write interrupted');const result=await original(...a);if(key==='rename'&&a[1]===signal&&result)await consume(f,signal);if(x===at&&when==='after')throw Error('direct write interrupted');return result}}
  await rejects(()=>deliver(f),/direct write interrupted/);interruptedOperations++;const dir=f.directory;await f.close();f=new PhysicalLocalFiles(dir)
  await deliver(f);check(await read(f,output),text);check(JSON.parse(await read(f,factPath)).published,true);check(await read(f,inputPath),'Original third-party input');await f.close()
 }
 // Real process termination, reopening physical files and continuing only the
 // original accepted business fact. Host startup wiring is verified separately.
 for(const mode of ['before-acceptance','accepted','result-prepared','result-renamed','signal-prepared','signal-renamed','signal-consumed','published']){
  const dir=path.join(scratch,'exit-'+mode);let f=new PhysicalLocalFiles(dir);await seed(f);await f.close()
  const child=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(import.meta.url),'--interrupt',dir,mode],{encoding:'utf8',timeout:30000});check(child.status,81);if(child.status!==81)throw Error(child.stderr);processInterruptions++
  f=new PhysicalLocalFiles(dir);await resumePhysicalDirectDelivery(f,inputPath,()=>sources(f))
  if(mode==='before-acceptance'){check(await read(f,factPath),undefined);check(await read(f,output),'Earlier designated output');check(await read(f,signal),undefined)}
  else{check(await read(f,output),text);check(JSON.parse(await read(f,factPath)).published,true);check(await read(f,signal),mode==='signal-consumed'?undefined:'')}
  await f.close()
 }
 // A missing source is not publication proof; a different same-name signal
 // cannot prove a deleted original, and nothing recreates or overwrites it.
 for(const kind of ['result-missing','result-edited','signal-missing','signal-new']){
  const f=new PhysicalLocalFiles(path.join(scratch,kind));await seed(f);const rename=f.rename.bind(f)
  f.rename=async(a,b)=>{if((kind.startsWith('result-')&&b===output)||(kind.startsWith('signal-')&&b===signal)){await f.delete(a);await f.delete(b);if(kind==='result-edited')await f.replace(b,'User replacement');if(kind==='signal-new')await f.replace(b,'');return false}return rename(a,b)}
  await rejects(()=>deliver(f),/cannot be established|not confirmed/);check(JSON.parse(await read(f,factPath)).published,undefined)
  check(await read(f,signal),kind==='signal-new'?'':undefined);if(kind==='result-edited')check(await read(f,output),'User replacement');await f.close()
 }
 // Hold one direct result publication. Another direct business object is
 // neither queued behind it nor forced to use the first output/recipient.
 const concurrent=new PhysicalLocalFiles(path.join(scratch,'parallel'));await seed(concurrent)
 let releaseOne,enterOne,held=false;const gateOne=new Promise(r=>releaseOne=r),enteredOne=new Promise(r=>enterOne=r),renameOne=concurrent.rename.bind(concurrent)
 concurrent.rename=async(a,b)=>{if(b===output&&!held){held=true;enterOne();await gateOne}return renameOne(a,b)}
 const first=deliver(concurrent);await enteredOne
 await Promise.race([deliver(concurrent,{selectedInput:'direct/other.md',execution:'other-execution'},false,{resultPath:'results/other.md',recipientSignal:'state/Foreground_other'}),new Promise((_,reject)=>setTimeout(()=>reject(Error('Independent direct delivery blocked')),3000))])
 check(await read(concurrent,'results/other.md'),text);check(await read(concurrent,'state/Foreground_other'),'');check(await read(concurrent,output),'Earlier designated output')
 releaseOne();await first;await concurrent.close()

 // Delivery settlement persists the source RoleRecord before the exact
 // technical retirement. Native result/turn closure is independent.
 const f=new PhysicalLocalFiles(path.join(scratch,'role-retirement'));await seed(f)
 let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r)
 const delivery=deliver(f,{settle:async(binding,command)=>{entered();await gate;await fs.writeFile(path.join(f.directory,'.test-source-role.json'),JSON.stringify({identity:binding,gitSettledWakeId:'original-wake'}));await retirePublishedDirectDelivery(f,binding.direct.inputPath,command)}},true)
 await ready;check(!!await read(f,factPath),true);release();const r=await delivery;await r.dispose()
 check(await read(f,factPath),undefined);check(existsSync(path.join(f.directory,work)),false);check(await read(f,inputPath),'Original third-party input');check(await read(f,output),text);check(await read(f,signal),'');check(JSON.parse(await fs.readFile(path.join(f.directory,'.test-source-role.json'),'utf8')).gitSettledWakeId,'original-wake')
 await consume(f,signal);await f.append(output,'\nUser edit after delivery')
 await deliver(f,{settled:async()=>JSON.parse(await fs.readFile(path.join(f.directory,'.test-source-role.json'),'utf8')).gitSettledWakeId==='original-wake'})
 check(await read(f,signal),undefined);check(await read(f,factPath),undefined);check(await read(f,output),text+'\nUser edit after delivery')
 // Failed settlement cannot retire accepted output. A replacement execution
 // resumes that same accepted command; changed output remains rejected.
 const g=new PhysicalLocalFiles(path.join(scratch,'cold-retirement'));await seed(g)
 await rejects(()=>deliver(g,{settle:async()=>{throw Error('source role persistence failed')}}),/source role persistence failed/)
 const accepted=JSON.parse(await read(g,factPath));check(accepted.published,true)
 await retirePublishedDirectDelivery(g,inputPath,'another-command');check(!!await read(g,factPath),true)
 let retainedCommand
 await deliver(g,{execution:'replacement-execution',settle:async(binding,command)=>{retainedCommand=command;await fs.writeFile(path.join(g.directory,'.test-source-role.json'),JSON.stringify({identity:binding,gitSettledWakeId:'original-wake'}));await retirePublishedDirectDelivery(g,inputPath,command)}})
 check(retainedCommand,accepted.commandId);check(await read(g,factPath),undefined);check(await read(g,output),text)
 await fs.mkdir(path.join(g.directory,work),{recursive:true});await resumePhysicalDirectDelivery(g,inputPath);check(existsSync(path.join(g.directory,work)),false)
 await f.close();await g.close()
 console.log(JSON.stringify({status:'passed',assertions,interruptedOperations,processInterruptions,limits:'Actual installed P/W direct delivery ports, physical publication and cold continuation, source-role settlement callback and precise retirement. Controlled native context/role-record persistence and recipient persistence using actual observed sources before deleteObserved; no full DSH, Host startup integration, Windows, full typecheck or powerloss claims.',sourceHashes:Object.fromEntries(loaded)},null,2))
}finally{await fs.rm(scratch,{recursive:true,force:true});hooks.deregister()}
