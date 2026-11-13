import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
// Actual Helper dss_snapshot/dss_record installation and physical files. Schema parsing
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
const attempt={faultId:'actual-fault',actionsTaken:'Checked the original owned operation',outcome:'attempted-not-repaired',result:'Still unconfirmed; retain original responsibility'}
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
let assertions=0,interruptedOperations=0,processInterruptions=0
const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
const rejects=async(fn,re)=>{await assert.rejects(fn,re);assertions++}
if(process.argv[2]==='--interrupt'){
 const f=new PhysicalLocalFiles(process.argv[3]),mode=process.argv[4],replace=f.replace.bind(f),rename=f.rename.bind(f),prepared=f.publishPreparedReport.bind(f),exit=()=>process.exit(81)
 f.replace=async(p,v)=>{if(mode==='before-acceptance'&&p===factPath)exit();await replace(p,v);if(p===factPath){const fact=JSON.parse(v);if(mode==='accepted'&&!fact.prepared)exit();if(mode==='report-prepared'&&fact.prepared&&!fact.reportSaved)exit();if(mode==='report-saved'&&fact.reportSaved&&!fact.signalVersion)exit();if(mode==='signal-prepared'&&fact.signalVersion&&!fact.signalSaved)exit();if(mode==='complete'&&fact.complete)exit()}}
 if(mode==='report-partial'){
  const open=fs.open.bind(fs);fs.open=async(p,...a)=>{const handle=await open(p,...a);if(p===path.join(f.directory,work,'report.stage')){const write=handle.write.bind(handle);handle.write=async(...args)=>{const result=await write(...args);exit();return result}}return handle}
 }
 f.publishPreparedReport=async(...a)=>{await prepared(...a);if(mode==='report-renamed')exit()}
 f.rename=async(a,b)=>{const result=await rename(a,b);if((mode==='signal-renamed'||mode==='signal-consumed')&&b===signal){if(mode==='signal-consumed')await consume(f,b);exit()}return result}
 await report(f,{record:async(input,id)=>{await recordAttempt(f,input,id);if(mode==='attempt-recorded')exit()}});throw Error('Expected interruption was not reached')
}
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'dss-helper-report-'))
try{
 const f=new PhysicalLocalFiles(path.join(scratch,'basic'));await seed(f)
 const order=[],rename=f.rename.bind(f),prepared=f.publishPreparedReport.bind(f)
 f.publishPreparedReport=async(...a)=>{await prepared(...a);order.push('report')}
 f.rename=async(a,b)=>{if(b===signal){check(await read(f,daily),earlier+body);order.push('signal')}return rename(a,b)}
 await report(f,{record:async(i,c)=>{check(await read(f,signal),'');order.push('attempt');await recordAttempt(f,i,c)}})
 check(order,['report','signal','attempt']);check(await read(f,daily),earlier+body);check(await read(f,signal),'')
 check(JSON.parse(await fs.readFile(path.join(f.directory,'.test-attempts.json'),'utf8')),[{id:agentId+':'+callId,input:attempt}])
 await consume(f,signal);await f.append(daily,'Later ordinary report\n');await report(f);check(await read(f,daily),earlier+body+'Later ordinary report\n');check(await read(f,signal),undefined)
 await rejects(()=>report(f,{}, {text:'changed text'}),/unchanged report text/)
 await f.close()
 // A persisted native source is required before accepting this compound
 // report; a failed existing DSH flush leaves no physical report fact/effects.
 const unsaved=new PhysicalLocalFiles(path.join(scratch,'source-flush-failed'));await seed(unsaved)
 await rejects(()=>report(unsaved,{flush:async()=>{throw Error('source call flush failed')}}),/source call flush failed/)
 check(await read(unsaved,daily),earlier);check(await read(unsaved,factPath),undefined);check(await read(unsaved,signal),undefined);await unsaved.close()
 // The actual cold parser may encounter rejected raw dss_record calls beside
 // accepted calls. Inspect the exact accepted fact before parsing arguments.
 const rejected=new PhysicalLocalFiles(path.join(scratch,'rejected-native-call'));await seed(rejected)
 const replaceRejected=rejected.replace.bind(rejected)
 rejected.replace=async(p,v)=>{await replaceRejected(p,v);if(p===factPath)throw Error('interrupted accepted original')}
 await rejects(()=>report(rejected),/interrupted accepted original/);rejected.replace=replaceRejected
 const acceptedEvents=await nativeEvents(rejected)
 await resumePhysicalHelperReportsFromEvents(rejected,execution,[{type:'tool/call',data:{name:'dss_record',callId:'rejected-bad-call',arguments:'{invalid'}} ,{type:'tool/result',data:{message:{toolCallId:'rejected-bad-call',isError:true}}},...acceptedEvents],services(rejected))
 check(await read(rejected,daily),earlier+body);check(JSON.parse(await read(rejected,factPath)).complete,true);await rejected.close()
 // Optional effects remain optional; no attempt result produces an automatic
 // user-facing signal. The original explicit named report signal stays empty.
 for(const [name,args,expected] of [
 ['attempt-only',{notifyForeground:false},undefined],['notify-only',{repairAttempt:undefined},signal],
 ['named',{path:'debug/helper-reports/实际处理.md',append:false,repairAttempt:undefined},'state/Foreground_Helper_Report_实际处理.md']]){
  const f=new PhysicalLocalFiles(path.join(scratch,name));await seed(f);await report(f,{},args);check(await read(f,signal),expected===signal?'':undefined)
  if(expected)check(await read(f,expected),'');if(name==='named')check(await read(f,args.path),body)
  if(name==='attempt-only')check((await f.fileInfo('state/Foreground_Helper_Report_实际处理.md')),undefined)
  await f.close()
 }
 // Fault-attempt uncertainty is separate from the already saved report/signal.
 const af=new PhysicalLocalFiles(path.join(scratch,'attempt-uncertain'));await seed(af)
 await rejects(()=>report(af,{record:async(i,c)=>{await recordAttempt(af,i,c);throw Error('controlled attempt result unknown')}}),/Record saved.*Foreground signal saved.*status is unconfirmed/)
 await consume(af,signal);await report(af);check(await read(af,daily),earlier+body);check(await read(af,signal),undefined);check(JSON.parse(await fs.readFile(path.join(af.directory,'.test-attempts.json'),'utf8')).length,1);await af.close()
 // Exhaust every public physical mutation boundary both before and after it.
 const trace=new PhysicalLocalFiles(path.join(scratch,'trace'));await seed(trace);let count=0
 for(const key of ['replace','rename','publishPreparedReport']){const fn=trace[key].bind(trace);trace[key]=async(...a)=>{count++;return fn(...a)}}
 await report(trace);await trace.close()
 for(const when of ['before','after'])for(let at=0;at<count;at++){
  let f=new PhysicalLocalFiles(path.join(scratch,when+'-'+at));await seed(f);let n=0
  for(const key of ['replace','rename','publishPreparedReport']){const fn=f[key].bind(f);f[key]=async(...a)=>{const x=n++;if(x===at&&when==='before')throw Error('controlled report interruption');const result=await fn(...a);if(key==='rename'&&a[1]===signal&&result)await consume(f,signal);if(x===at&&when==='after')throw Error('controlled report interruption');return result}}
  await rejects(()=>report(f),/controlled report interruption/);interruptedOperations++;const directory=f.directory;await f.close();f=new PhysicalLocalFiles(directory)
  await report(f);check(await read(f,daily),earlier+body);check(JSON.parse(await read(f,factPath)).complete,true);check(JSON.parse(await fs.readFile(path.join(f.directory,'.test-attempts.json'),'utf8')).length,1);await f.close()
 }
 // New OS process: native call evidence, exact original execution, no scan and
 // no resumed in-memory object. A native call before acceptance creates nothing.
 for(const mode of ['before-acceptance','accepted','report-partial','report-prepared','report-renamed','report-saved','signal-prepared','signal-renamed','signal-consumed','attempt-recorded','complete']){
  const directory=path.join(scratch,'exit-'+mode);let f=new PhysicalLocalFiles(directory);await seed(f);await f.close()
  const child=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(import.meta.url),'--interrupt',directory,mode],{encoding:'utf8',timeout:30000});check(child.status,81);if(child.status!==81)throw Error(child.stderr);processInterruptions++
  f=new PhysicalLocalFiles(directory);for(const key of ['list','listDirectory','listDirectoryNames'])f[key]=async()=>{throw Error('No Helper publication scan is allowed')}
  const events=await nativeEvents(f);await resumePhysicalHelperReportsFromEvents(f,execution,events,services(f))
  if(mode==='before-acceptance'){check(await read(f,daily),earlier);check(await read(f,signal),undefined);check(await read(f,factPath),undefined)}
  else{check(await read(f,daily),earlier+body);check(await read(f,signal),mode==='signal-consumed'?undefined:'');check(JSON.parse(await read(f,factPath)).complete,true);check(JSON.parse(await fs.readFile(path.join(f.directory,'.test-attempts.json'),'utf8')),[{id:agentId+':'+callId,input:attempt}])}
  await f.close()
 }
 // Prepared old full-day report cannot overwrite another actual report/user edit.
 {
  const f=new PhysicalLocalFiles(path.join(scratch,'renamed-then-in-place-append'));await seed(f)
  const prepared=f.publishPreparedReport.bind(f)
  f.publishPreparedReport=async(...a)=>{await prepared(...a);throw Error('stop after report rename')}
  await rejects(()=>report(f),/stop after report/);f.publishPreparedReport=prepared
  await f.append(daily,'User later edited this report\n')
  const before=await read(f,daily)
  await resumePhysicalHelperReportsFromEvents(f,execution,await nativeEvents(f),services(f))
  check(await read(f,daily),before);check(await read(f,signal),'')
  check(JSON.parse(await read(f,factPath)).complete,true)
  check(JSON.parse(await fs.readFile(path.join(f.directory,'.test-attempts.json'),'utf8')).length,1)
  await f.close()
 }
 for(const change of ['append','replace','delete','stage-delete','stage-replaced','renamed-then-edit']){
  const f=new PhysicalLocalFiles(path.join(scratch,'changed-'+change));await seed(f);const replace=f.replace.bind(f),prepared=f.publishPreparedReport.bind(f)
  if(change==='renamed-then-edit')f.publishPreparedReport=async(...a)=>{await prepared(...a);throw Error('stop after report rename')}
  else f.replace=async(p,v)=>{await replace(p,v);if(p===factPath&&JSON.parse(v).prepared)throw Error('stop after report stage')}
  await rejects(()=>report(f),/stop after report/);f.replace=replace;f.publishPreparedReport=prepared
  if(change==='append')await f.append(daily,'other report')
  if(change==='replace'||change==='renamed-then-edit')await f.replace(daily,'user replacement')
  if(change==='delete')await f.delete(daily)
  if(change==='stage-delete')await f.delete(work+'/report.stage')
  if(change==='stage-replaced')await f.replace(work+'/report.stage',earlier+body)
  const before=await read(f,daily);await rejects(async()=>resumePhysicalHelperReportsFromEvents(f,execution,await nativeEvents(f),services(f)),/remain unconfirmed/)
  check(await read(f,daily),before);check(await read(f,signal),undefined);check(JSON.parse(await read(f,factPath)).reportSaved,undefined);await f.close()
 }
 // A deleted signal stage cannot become success from an unrelated same-name
 // signal, even when the latter is also an empty file.
 for(const replacement of [false,true]){
  const f=new PhysicalLocalFiles(path.join(scratch,'lost-signal-'+replacement));await seed(f);const rename=f.rename.bind(f)
  f.rename=async(a,b)=>{if(b===signal){await f.delete(a);if(replacement)await f.replace(b,'');return false}return rename(a,b)}
  await rejects(()=>report(f),/not confirmed/);check(await read(f,daily),earlier+body);check(JSON.parse(await read(f,factPath)).complete,undefined);check(existsSync(path.join(f.directory,'.test-attempts.json')),false);await f.close()
 }
 // Ordinary calls still directly append without a compound publication.
 const p=new PhysicalLocalFiles(path.join(scratch,'plain'));await seed(p);p.publishPreparedReport=async()=>{throw Error('Plain record entered compound publication')}
 await report(p,{}, {notifyForeground:false,repairAttempt:undefined});check(await read(p,daily),earlier+body);check(await read(p,factPath),undefined);await p.close()
 // Existing large report streams, not readBytes/whole-file Buffer.concat.
 const large=new PhysicalLocalFiles(path.join(scratch,'large'));await large.replace(daily,'x'.repeat(2*1024*1024))
 const readBytes=LocalRecordFiles.prototype.readBytes;LocalRecordFiles.prototype.readBytes=async function(p){if(p===daily)throw Error('Do not allocate/read whole daily report');return readBytes.call(this,p)}
 try{await report(large)}finally{LocalRecordFiles.prototype.readBytes=readBytes}
 check((await large.fileInfo(daily)).bytes,2*1024*1024+Buffer.byteLength(body));await large.close()
 // Holding one report cannot block an unrelated report/task file.
 const parallel=new PhysicalLocalFiles(path.join(scratch,'parallel'));await seed(parallel);const publish=parallel.publishPreparedReport.bind(parallel)
 let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r)
 parallel.publishPreparedReport=async(...a)=>{if(a[0]===daily){enter();await gate}return publish(...a)}
 const first=report(parallel);await entered
 await report(parallel,{run:'independent-helper-execution'},{path:'debug/helper-reports/independent.md',repairAttempt:undefined})
 await parallel.append('task-runs/independent/notes.md','Independent task');check(await read(parallel,'debug/helper-reports/independent.md'),body);check(await read(parallel,daily),earlier);release();await first;await parallel.close()
 // Exact native-success retirement waits for real Session flush, then keeps
 // business records and signals. Helper snapshot has no TaskID.
 const done=new PhysicalLocalFiles(path.join(scratch,'retirement'));await seed(done);let releaseFlush,enterFlush
 const flushGate=new Promise(r=>releaseFlush=r),flushEntered=new Promise(r=>enterFlush=r)
 let doneFlushes=0
 const r=await report(done,{flush:async()=>{if(++doneFlushes===1)return;enterFlush();await flushGate}}, {},true);await flushEntered
 check(!!await read(done,factPath),true);releaseFlush();await r.dispose();check(r.errors,[]);check(await read(done,factPath),undefined);check(existsSync(path.join(done.directory,work)),false);check(await read(done,daily),earlier+body);check(await read(done,signal),'')
 await resumePhysicalHelperReportsFromEvents(done,execution,r.events,services(done));check(await read(done,daily),earlier+body);check(await read(done,factPath),undefined);await done.close()
 const failed=new PhysicalLocalFiles(path.join(scratch,'flush-failed'));await seed(failed)
 let failedFlushes=0
 const fr=await report(failed,{flush:async()=>{if(++failedFlushes>1)throw Error('native flush failed')}},{},true);await fr.dispose();check(fr.errors.length,1);check(!!await read(failed,factPath),true)
 await retirePhysicalHelperReportsFromEvents(failed,execution,fr.events);check(await read(failed,factPath),undefined);await failed.close()
 console.log(JSON.stringify({status:'passed',assertions,interruptedOperations,processInterruptions,limits:'Actual installed Helper tools, real POSIX physical files and stream preparation, original native-source cold continuation with controlled native context and safety-attempt callback. No native DSH, Windows, full typecheck, physical power-loss durability or auto-escalation claim.',sourceHashes:Object.fromEntries(loaded)},null,2))
}finally{await fs.rm(scratch,{recursive:true,force:true});hooks.deregister()}
