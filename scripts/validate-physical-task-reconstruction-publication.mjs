import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Actual runtime signal-consumption methods and physical filesystem. Native DSH
// execution and unrelated parser/skill imports are explicit stubs; this does not
// claim native integration, Windows, full typecheck or production cutover.
const sourceRoot = new URL('../src/', import.meta.url), loaded = new Map()
const data = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const unexpected = `const no = () => { throw new Error('Native DSH is outside this controlled check') };`
const native = {
  '@deepseek-ai/dsh-session': `${unexpected} export const SessionId=x=>x, SessionLogOffset=x=>x, deriveEventMessage=no, isAppendSurfaceEvent=no;`,
  '@deepseek-ai/dsh-session-persistence': `export class SessionAlreadyOwnedError extends Error{}; export class SessionPersistenceNotFoundError extends Error{};`,
  '@deepseek-ai/dsh-agent': `${unexpected} export const installModelSelection=no;`,
  '@deepseek-ai/dsh-llm': `${unexpected} export const MessageId=x=>x, freezeMessage=no, errorChain=no;`,
  '@deepseek-ai/dsh-llm/assistant-stream': `${unexpected} export const expandAssistantStream=no;`,
}
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (native[specifier]) return { url: data(native[specifier]), shortCircuit: true }
    if (specifier === 'zod') return { url: data(`const schema=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;if(k==='toJSONSchema')return ()=>({});return schema},apply(){return schema}});export const z=schema;`), shortCircuit: true }
    if (specifier === 'mdast-util-from-markdown') return { url: data(`${unexpected} export const fromMarkdown=no;`), shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith(sourceRoot.href) && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
      if (url.href === new URL('framework/skills.ts',sourceRoot).href) return { url:data(`${unexpected} export function isFrameworkSkillDefinitionPath(){throw new Error("Skill definition classification is outside this focused test")} export const frameworkSkillIndexPath='skills/index.md', prepareFrameworkSkillIndex=no, installFrameworkSkillProvider=no, initializeFrameworkSkillIndex=no, readFrameworkSkillCatalog=no;`),shortCircuit:true }
      if (existsSync(fileURLToPath(url))) return { url:url.href,shortCircuit:true }
    }
    return next(specifier,context)
  },
  load(url,context,next) {
    if(url.startsWith(sourceRoot.href)&&url.endsWith('.ts')) {
      const source=readFileSync(url === new URL('framework/physical-task-recovery.ts',sourceRoot).href && process.env.DSS_RECONSTRUCTION_BASELINE ? process.env.DSS_RECONSTRUCTION_BASELINE : process.env.DSS_RECONSTRUCTION_SOURCE_ROOT ? path.join(process.env.DSS_RECONSTRUCTION_SOURCE_ROOT,url.slice(sourceRoot.href.length)) : new URL(url),'utf8');loaded.set(url.slice(sourceRoot.href.length),createHash('sha256').update(source).digest('hex'))
      return {format:'module',source:stripTypeScriptTypes(source,{mode:'transform',sourceUrl:url}),shortCircuit:true}
    }
    return next(url,context)
  },
})
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { FrameworkRoleRuntime } = await import('../src/framework/role-runtime.ts')
const { paths } = await import('../src/framework/task-files.ts')
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')
const { publishPhysicalRecovery } = await import('../src/framework/physical-recovery.ts')

const { reconstructPhysicalTask } = await import('../src/framework/physical-task-recovery.ts')
const { TaskWorkspaces } = await import('../src/framework/task-workspace.ts')
let assertions=0,cases=0
const processRuns=[]
const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
const rejects=async(fn,match)=>{await assert.rejects(fn,match);assertions++}
const hash=x=>createHash('sha256').update(x).digest('hex')
const child=process.argv[2]==='--child',probe=process.argv[2]==='--probe'
const root=child?process.argv[3]:await fs.mkdtemp(path.join(os.tmpdir(),'dss-task-publication-'))
const task={version:1,taskId:'10000000-0000-4000-8000-000000000001',route:'P',owner:'A',members:['A'],status:'running',sourcePath:'tasks/a.md'}
const command='accepted-task-reconstruction',operation=id=>paths.run(id)+'/.recovery/reconstruct-'+hash(command)
const read=async(f,p)=>{const snapshot=await f.snapshot();try{return await f.read(snapshot,p)}finally{await snapshot.release()}}
const fact=f=>read(f,operation(task.taskId)+'.json').then(x=>x&&JSON.parse(x))
const input={target:{workId:'original-planner',executionId:'original-execution',role:'Planner',taskId:task.taskId,member:'A'},taskRecovery:{route:'P',owner:'A',recordPaths:[paths.member(task.taskId,'A')+'/Planner_Memory.md'],continuation:'Continue from these exact original records.'}}
async function rig(name,reopen=false,status='running'){
 const directory=path.join(root,name),files=new PhysicalLocalFiles(path.join(directory,'files'))
 const workspaces=new TaskWorkspaces(files,path.join(directory,'outputs'),'A','20000000-0000-4000-8000-000000000001')
 const records={async get(k){try{return JSON.parse(await fs.readFile(path.join(directory,'records',hash(k)+'.json'),'utf8'))}catch(e){if(e.code==='ENOENT')return;throw e}},async set(k,v){await fs.mkdir(path.join(directory,'records'),{recursive:true});await fs.writeFile(path.join(directory,'records',hash(k)+'.json'),JSON.stringify(v))}}
 const roleKey='runtime/roles/'+hash(input.target.workId)
 if(!reopen){
  await files.replace(paths.task(task.taskId),JSON.stringify({...task,status}))
  const location=await workspaces.ensure(task.taskId)
  await fs.writeFile(path.join(location.directory,'original.bin'),Buffer.from([0,255,10,7]))
  await files.replace(input.taskRecovery.recordPaths[0],'Original retained Memory, not a new instruction.')
  if(status==='cancelled')await files.replace(task.sourcePath,'Original accepted source for cancelled task.')
  await records.set(roleKey,{identity:input.target,sessionId:'original-session',generation:1,stopped:true,taskWorkspace:location})
 }
 const record=await records.get(roleKey),row={key:'restore/exact',value:{commandId:command,createdAt:'2026-11-08T00:00:00Z',complete:false,input:structuredClone(input)}}
 // Task control cold discovery is an independent port here; the dedicated
 // validate-g20-task-control-reconstruction suite runs its real ownership chain.
 const runtime=Object.create(FrameworkRoleRuntime.prototype)
 Object.assign(runtime,{files,records,prefix:'runtime/',config:{member:'A',workspace:workspaces.root},workspaces,closed:false,roleRecords:new Map([[record.identity.workId,record]]),
  knownTaskLifecycles:new Map(),observedTerminalTasks:new Map(),pendingTaskControlDiscovery:new Map(),startTaskControlDiscovery(){},loop:{hasTerminalTask:()=>false},archiveHostKey:()=> 'A',trackedStop:()=>true,serialWork:async(_id,fn)=>fn(),
  ctx:{sessions:{get:()=>({header:{cwd:record.taskWorkspace?.directory}})},get:()=>undefined},transactions:{run(){throw Error('Unexpected generic reconstruction transaction')}},
  updateSafetyRestoreRow:async(_key,_id,update)=>{const changed=update(row.value);Object.assign(row.value,changed);return changed},
  saveRole:async value=>{runtime.roleRecords.set(value.identity.workId,value);await records.set(roleKey,value)}})
 let calls=0
 const toolsFor=()=>{
  const installed=new Map(),binding={...record.identity,role:'Planner',owner:'A'},agent={id:'controlled-Planner',session:{}},ctx={on:()=>()=>{},effect:()=>{},systemPrompt:{section(){}},tools:{register:t=>installed.set(t.name,t)}}
  installFrameworkRoleTools(ctx,agent,binding,{files,transact:async()=>{throw Error('Unexpected generic transaction')},notifications:async()=>[],claimNotifications:async()=>({signals:[]}),onError:()=>{}})
  return {call:(name,value)=>installed.get(name).execute(value,{agent,callId:'read-'+(++calls),signal:new AbortController().signal,concludeTurn(){}})}
 }
 return {files,records,runtime,row,record,toolsFor,call:()=>runtime.recoverMissingTask(row)}
}
function pauseAfterPlan(f){const replace=f.replace.bind(f);let hit=false;f.replace=async(p,...args)=>{const result=await replace(p,...args);if(!hit&&p===operation(task.taskId)+'.json'){hit=true;throw Error('interrupted after accepted plan')}return result};return ()=>{f.replace=replace}}
async function paused(name,status='running'){const r=await rig(name,false,status),undo=pauseAfterPlan(r.files);await rejects(r.call,/after accepted plan/);undo();return r}
const unconfirmed=/missing|unavailable|unconfirmed|not confirmed|changed/i
if(probe){
 const observations=[]
 for(const [status,kind] of [['running','source'],['cancelled','source'],['running','task']]){
  const r=await paused('probe-'+status+'-'+kind,status),prepared=await fact(r.files)
  await r.files.delete(prepared[kind].stage)
  let error;try{await r.call()}catch(e){error=e.message}
  const result=await fact(r.files),target=await read(r.files,prepared[kind].path)
  observations.push({status,kind,complete:result.complete??false,targetPresent:target!==undefined,error:error??null})
  await r.files.close()
 }
 console.log(JSON.stringify({status:'observed',observations,assertions,sourceHashes:Object.fromEntries(loaded)},null,2))
 for(const observed of observations)check(observed.complete,false)
 await fs.rm(root,{recursive:true,force:true});hooks.deregister();process.exit(0)
}
const observedMethods=['replace','stageCopy','publishPreparedReport','renameIfAbsent','deleteObserved']
function intercept(files,callback){
 const originals=new Map()
 for(const name of observedMethods){const actual=files[name].bind(files);originals.set(name,actual);files[name]=async(...args)=>{await callback('before',name,args);const result=await actual(...args);await callback('after',name,args,result);return result}}
 return ()=>{for(const [name,actual] of originals)files[name]=actual}
}
async function verify(r){
 const saved=await fact(r.files);check(saved.complete,true)
 for(const name of ['task','source','inbox','memberStatus','cache'])if(saved[name]){
  check(saved[name].published||saved[name].preserved,true)
  if(saved[name].published)check(await r.files.fileInfo(saved[name].path)!==undefined,true)
 }
 const metadata=JSON.parse(await read(r.files,paths.task(task.taskId)))
 check(metadata.taskId,task.taskId);check(metadata.status,'running')
 check([...await fs.readFile(path.join(r.record.taskWorkspace.directory,'original.bin'))],[0,255,10,7])
 check(await read(r.files,input.taskRecovery.recordPaths[0]),'Original retained Memory, not a new instruction.')
 const tools=r.toolsFor(),snapshot=await tools.call('dss_snapshot',{})
 const content=await tools.call('dss_read',{snapshotId:snapshot.snapshotId,path:metadata.sourcePath})
 check(JSON.stringify(content).includes('Continue from these exact original records.'),true)
 await tools.call('dss_snapshot_release',{snapshotId:snapshot.snapshotId})
 if(saved.history){
  for(const copy of saved.history.copies){const preserved=await r.files.fingerprint(copy.target);check(preserved,copy.prepared)}
  check(saved.history.execution.published,true);check(saved.history.recovery.published,true)
 }
}
if(child){
 const mode=process.argv[4],status=process.argv[5],name=process.argv[6],when=process.argv[7],stop=Number(process.argv[8])
 const r=await rig(name,mode==='resume',status)
 if(mode==='cut'){
  let next=0,index=-1
  intercept(r.files,async(phase,method,args)=>{
   if(phase==='before')index=next++
   if(phase===when&&index===stop){
    await fs.writeFile(path.join(root,'exit-observation.json'),JSON.stringify({when,stop,method,target:args[0],sourceHashes:Object.fromEntries(loaded)}))
    process.exit(73)
   }
  })
  await r.call();throw Error('The requested real process exit was not reached')
 }
 await r.call();await verify(r);await r.files.close()
 console.log(JSON.stringify({status:'passed',assertions,sourceHashes:Object.fromEntries(loaded)}));hooks.deregister();process.exit(0)
}
try{
 // The real reconstruction body must reject a known complete Task before
 // preparing any publication. A cancelled Task is exercised below instead.
 {
  const r=await rig('completed-closed',false,'complete')
  await rejects(r.call,/completed Task cannot resume the same Task ID/)
  check(JSON.parse(await read(r.files,paths.task(task.taskId))).status,'complete')
  check(await fact(r.files),undefined)
  await r.files.close();cases++
 }
 // The three baseline failures plus every support body: no missing stage is
 // evidence of a previous publication, even if another file has equal bytes.
 for(const status of ['running','cancelled'])for(const kind of ['source','inbox','memberStatus','cache','task']){
  let r=await paused('missing-'+status+'-'+kind,status),saved=await fact(r.files),body=saved[kind]
  await r.files.delete(body.stage);await r.files.close();r=await rig('missing-'+status+'-'+kind,true,status)
  await rejects(r.call,unconfirmed);check((await fact(r.files)).complete,undefined)
  // Unknown completion of one Task never blocks an unrelated Task.
  const other={...task,taskId:'10000000-0000-4000-8000-000000000002',sourcePath:'tasks/independent.md'}
  await reconstructPhysicalTask(r.files,other.taskId,'independent',{},async()=>({task:other,source:{path:other.sourcePath,text:'Independent work'}}),()=>{})
  check(JSON.parse(await read(r.files,paths.task(other.taskId))),other)
  await r.files.close();cases++
 }
 for(const same of [false,true]){
  const r=await paused('missing-with-existing-'+same),saved=await fact(r.files),body=saved.source,text=await read(r.files,body.stage)
  await r.files.delete(body.stage);await r.files.replace(body.path,same?text:'Unrelated user text')
  const version=(await r.files.fileInfo(body.path)).version
  await rejects(r.call,unconfirmed);check((await fact(r.files)).complete,undefined)
  check((await r.files.fileInfo(body.path)).version,version);await r.files.close();cases++
 }
 // Fill-only bodies intentionally preserve a user-created file, including
 // binary content, and persist that decision before removing only our stage.
 for(const kind of ['source','inbox','memberStatus','cache']){
  const r=await paused('preserve-'+kind),saved=await fact(r.files),body=saved[kind]
  const bytes=kind==='cache'?Buffer.from('{"version":1,"links":[]}'):Buffer.from([0,255,13,10,65])
  await r.files.replace(body.path,bytes);const version=(await r.files.fileInfo(body.path)).version
  await r.call();check((await fact(r.files))[kind].preserved,true);check((await r.files.fileInfo(body.path)).version,version)
  const snapshot=await r.files.snapshot();check(Buffer.from(await r.files.readBytes(snapshot,body.path)),bytes);await snapshot.release()
  check(await r.files.fileInfo(body.stage),undefined);await r.files.close();cases++
 }
 for(const cut of ['after-preserved-fact','after-unused-stage-delete']){
  let r=await paused('preserve-cut-'+cut),body=(await fact(r.files)).source
  await r.files.replace(body.path,'User text, intentionally kept')
  let hit=false
  const undo=intercept(r.files,async(when,method,args)=>{
   if(!hit&&when==='after'&&(cut==='after-preserved-fact'&&method==='replace'&&args[0]===operation(task.taskId)+'.json'&&JSON.parse(args[1]).source.preserved
     ||cut==='after-unused-stage-delete'&&method==='deleteObserved'&&args[0]===body.stage)){hit=true;throw Error('preservation interrupted')}
  })
  await rejects(r.call,/preservation interrupted/);undo();check(hit,true)
  await r.files.delete(body.path);await r.files.close();r=await rig('preserve-cut-'+cut,true)
  await r.call();check(await r.files.fileInfo(body.path),undefined);check((await fact(r.files)).complete,true);await r.files.close();cases++
 }
 // Non-fill restoration may replace only its unchanged accepted destination.
 // Later edits or new files are preserved, as are tampered staged originals.
 for(const status of ['running','cancelled'])for(const tamper of ['stage','target']){
  const r=await paused('tamper-'+status+'-'+tamper,status),saved=await fact(r.files),body=status==='running'?saved.task:saved.source
  const selected=tamper==='stage'?body.stage:body.path
  await r.files.replace(selected,'A later user edit')
  const stageBefore=await read(r.files,body.stage),targetBefore=await read(r.files,body.path)
  await rejects(r.call,unconfirmed);check((await fact(r.files)).complete,undefined)
  check(await read(r.files,body.stage),stageBefore);check(await read(r.files,body.path),targetBefore);await r.files.close();cases++
 }
 // A real successful rename is accepted after the process lost its return.
 // An indistinguishable-looking replacement with another identity is not.
 for(const status of ['running','cancelled'])for(const after of ['none','edit','in-place-edit','delete','same-bytes-replace']){
  let r=await paused('rename-gap-'+status+'-'+after,status),body=(await fact(r.files)).source,text=await read(r.files,body.stage)
  check(await r.files.rename(body.stage,body.path),true)
  if(after==='edit')await r.files.replace(body.path,'User edit after original publication')
  if(after==='in-place-edit')await r.files.append(body.path,'User edit after original publication')
  if(after==='delete')await r.files.delete(body.path)
  if(after==='same-bytes-replace')await r.files.replace(body.path,text)
  await r.files.close();r=await rig('rename-gap-'+status+'-'+after,true,status)
  if(after==='none'){await r.call();check((await fact(r.files)).complete,true);check(await read(r.files,body.path),text)}
  else{await rejects(r.call,unconfirmed);check((await fact(r.files)).complete,undefined)}
  await r.files.close();cases++
 }
 // Once this body is durably recorded, another unfinished body does not turn
 // later user edits/removal into an implicit replay or a lasting version lock.
 for(const after of ['edit','delete']){
  let r=await paused('published-'+after),body=(await fact(r.files)).source,hit=false
  const undo=intercept(r.files,async(when,method,args)=>{if(!hit&&when==='after'&&method==='replace'&&args[0]===operation(task.taskId)+'.json'&&JSON.parse(args[1]).source.published){hit=true;throw Error('published body interrupted')}})
  await rejects(r.call,/published body interrupted/);undo();check(hit,true)
  if(after==='edit')await r.files.replace(body.path,'Later real user edit');else await r.files.delete(body.path)
  await r.files.close();r=await rig('published-'+after,true)
  await r.call();check((await fact(r.files)).complete,true);check(await read(r.files,body.path),after==='edit'?'Later real user edit':undefined);await r.files.close();cases++
 }
 // Legacy incomplete facts without a saved identity cannot prove publication.
 // Keep their original stage instead of silently relabelling current files.
 {
  const r=await paused('legacy-unknown'),saved=await fact(r.files),bytes=await read(r.files,saved.source.stage)
  delete saved.source.prepared;await r.files.replace(operation(task.taskId)+'.json',JSON.stringify(saved))
  await rejects(r.call,unconfirmed);check(await read(r.files,saved.source.stage),bytes);check((await fact(r.files)).complete,undefined);await r.files.close();cases++
 }
 // Already-existing lifecycle history must not be overwritten by a staged
 // original, whether it appeared before preparation or just before publication.
 for(const same of [false,true]){
  let r=await paused('history-existing-'+same,'cancelled'),saved=await fact(r.files),copy=saved.history.copies[0],hit=false
  const undo=intercept(r.files,async(when,method,args)=>{
   if(!hit&&when==='before'&&method==='renameIfAbsent'&&args[0]===copy.stage){hit=true;await r.files.replace(copy.target,same?await read(r.files,copy.source):'Existing user history')}
  })
  if(same){await r.call();check((await fact(r.files)).complete,true)}else{await rejects(r.call,/not preserved/);check((await fact(r.files)).complete,undefined);check(await read(r.files,copy.target),'Existing user history')}
  undo();check(hit,true);await r.files.close();cases++
 }
 // Neither a terminal Task nor missing structures initiate restoration by
 // themselves. The actual runtime still requires the explicit recovery input.
 for(const status of ['running','cancelled']){
  const r=await rig('no-authorized-input-'+status,false,status),original=await read(r.files,paths.task(task.taskId))
  delete r.row.value.input.taskRecovery
  await rejects(r.call,/requires one exact Task execution target/)
  check(await read(r.files,paths.task(task.taskId)),original);check(await fact(r.files),undefined);await r.files.close();cases++
 }
 // Source disappearance between observation and the real no-replace handoff
 // is also an unknown result, never a successful fill-only publication.
 {
  const r=await paused('source-missing-at-handoff'),body=(await fact(r.files)).source,actual=r.files.renameIfAbsent.bind(r.files)
  r.files.renameIfAbsent=async(from,to)=>{if(from===body.stage)await r.files.delete(from);return actual(from,to)}
  await rejects(r.call,unconfirmed);check((await fact(r.files)).complete,undefined);check(await r.files.fileInfo(body.path),undefined);await r.files.close();cases++
 }
 // Persisted replacement identities must not serialize an unrelated Task.
 {
  const r=await paused('independent-in-flight');let entered,release
  const began=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve),actual=r.files.publishPreparedReport.bind(r.files)
  r.files.publishPreparedReport=async(...args)=>{if(args[0]===paths.task(task.taskId)){entered();await held}return actual(...args)}
  const first=r.call();await began
  const other={...task,taskId:'10000000-0000-4000-8000-000000000003',sourcePath:'tasks/other.md'}
  await reconstructPhysicalTask(r.files,other.taskId,'independent-live',{},async()=>({task:other}),()=>{})
  check(JSON.parse(await read(r.files,paths.task(other.taskId))),other);release();await first;await r.files.close();cases++
 }
 // Actual subprocess exits before and after every addressed mutation in the
 // real runtime path. Each continuation is a fresh process with disk-only state.
 const sourceSets=new Map()
 for(const status of ['running','cancelled']){
  const traceRig=await rig('trace-'+status,false,status),trace=[]
  const undo=intercept(traceRig.files,async(when,method,args)=>{if(when==='before')trace.push({method,target:args[0]})})
  await traceRig.call();undo();await verify(traceRig);await traceRig.files.close()
  for(const when of ['before','after'])for(let stop=0;stop<trace.length;stop++){
   const name='process-'+status+'-'+when+'-'+stop
   const exited=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(import.meta.url),'--child',root,'cut',status,name,when,String(stop)],{encoding:'utf8'})
   assert.equal(exited.status,73,exited.stderr||exited.stdout);assertions++
   const observation=JSON.parse(await fs.readFile(path.join(root,'exit-observation.json'),'utf8'))
   check(observation.method,trace[stop].method);check(observation.target,trace[stop].target)
   const resumed=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(import.meta.url),'--child',root,'resume',status,name],{encoding:'utf8'})
   assert.equal(resumed.status,0,resumed.stderr||resumed.stdout);assertions++
   const result=JSON.parse(resumed.stdout);assertions+=result.assertions
   sourceSets.set(hash(JSON.stringify(result.sourceHashes)),result.sourceHashes)
   processRuns.push({status,when,stop,method:trace[stop].method,exit:exited.status,resume:resumed.status})
  }
 }
 console.log(JSON.stringify({status:'passed',assertions,cases,processExitContinuations:processRuns.length,processRuns,childSourceSets:Object.fromEntries(sourceSets),
  limits:'Actual imported FrameworkRoleRuntime.recoverMissingTask and installed dss_snapshot/dss_read, exact physical files, cold retries and real process.exit(73). Native session/technical-record ports and unrelated parser/skill/native imports are controlled. No Windows, full typecheck, native DSH, power-loss durability, cross-process rename atomicity or production cutover claim.',sourceHashes:Object.fromEntries(loaded)},null,2))
}finally{await fs.rm(root,{recursive:true,force:true});hooks.deregister()}
