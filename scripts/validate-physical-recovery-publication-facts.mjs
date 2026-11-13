import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module'

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
// v56 imports the real storage adapter class. Resolve its SDK domain from the
// supplied actual Host installation; these tests still use controlled KV ports.
const sdkRequire = process.env.DSS_SDK_HOST_ROOT ? createRequire(path.join(process.env.DSS_SDK_HOST_ROOT, 'package.json')) : undefined
const storageSdkUrls = sdkRequire ? Object.fromEntries(['@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-storage-json'].map(name => [name, pathToFileURL(sdkRequire.resolve(name)).href])) : {}
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (storageSdkUrls[specifier]) return { url: storageSdkUrls[specifier], shortCircuit: true }
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
      const source=readFileSync(new URL(url),'utf8');loaded.set(url.slice(sourceRoot.href.length),createHash('sha256').update(source).digest('hex'))
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
const { hostRecoveryDebugPath, hostRecoverySignalPath } = await import('../src/framework/recovery-debug-record.ts')
let assertions=0,cases=0
const processRuns=[]
const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
const rejects=async(fn,match)=>{await assert.rejects(fn,match);assertions++}
const hash=x=>createHash('sha256').update(x).digest('hex')
const child=process.argv[2]==='--child'
const root=child?process.argv[3]:await fs.mkdtemp(path.join(os.tmpdir(),'dss-recovery-publication-'))
const task={version:1,taskId:'10000000-0000-4000-8000-000000000001',route:'P',owner:'A',members:['A'],status:'running',sourcePath:'tasks/a.md'}
const marker=paths.state('A',task.taskId)+'/recovery',legacySignal=paths.state('A',task.taskId)+'/Planner_Recovery_2026-11-08_original'
const note=paths.member(task.taskId,'A')+'/Planner_Memory.md',dailyDebug='debug/2026-11-08.md'
let signal=legacySignal,debug=dailyDebug
const inputPath='technical/recovery-inputs/'+task.taskId+'/A/Planner.json'
const operation=commandId=>paths.run(task.taskId)+'/.recovery/'+hash(commandId)
const read=async(f,p)=>{const snapshot=await f.snapshot();try{return await f.read(snapshot,p)}finally{await snapshot.release()}}
async function rig(name,reopen=false){
 // These member/Host cases now use their real per-operation record and signal.
 // The pre-existing addressed body still tests preservation across publication.
 const command=({'process':'process-member','consumed-signal':'accepted-member','normal':'normal-member','consumed-marker':'marker-gap','parallel-tasks':'held-marker','host-manager':'host-restore-debug:host-original'})[name] ?? (name.startsWith('unproven-signal-')?'unproven-signal':undefined)
 debug=command?hostRecoveryDebugPath(dailyDebug,command):dailyDebug
 signal=command&&name!=='host-manager'?hostRecoverySignalPath(legacySignal,debug):legacySignal
 const directory=path.join(root,name),files=new PhysicalLocalFiles(path.join(directory,'files'))
 // Existing technical storage port, backed by exact key files across reconstruction.
 // This controls native admission/record persistence, not the recovery algorithm.
 const records={async get(k){try{return JSON.parse(await fs.readFile(path.join(directory,'records',hash(k)+'.json'),'utf8'))}catch(e){if(e.code==='ENOENT')return;throw e}},async set(k,v){await fs.mkdir(path.join(directory,'records'),{recursive:true});await fs.writeFile(path.join(directory,'records',hash(k)+'.json'),JSON.stringify(v))}}
 const runtime=Object.create(FrameworkRoleRuntime.prototype)
 Object.assign(runtime,{files,records,closed:false,config:{member:'A',primary:true},prefix:'focused/',native:new Map(),roleRecords:new Map(),wakeConsumptions:new Map(),recoveryWatchWrites:new Map(),
  transactions:{run(){throw Error('Unexpected generic transaction')}},manuallyCleared:async()=>false})
 if(!reopen){await files.replace(paths.task(task.taskId),JSON.stringify(task));await files.replace(paths.inbox(task.taskId,'A'),'original inbox');await files.replace(note,'original Memory\n');await files.replace(debug,'original debug\n')}
 let calls=0
 const bind=(role='Planner')=>({role,taskId:task.taskId,owner:'A',member:'A',workId:runtime.roleKey(role,task.taskId),executionId:'receiver-'+role})
 const toolsFor=binding=>{
  const installed=new Map(),agent={id:'agent-'+binding.role,session:{}},ctx={on:()=>()=>{},effect:()=>{},systemPrompt:{section(){}},tools:{register:t=>installed.set(t.name,t)}}
  installFrameworkRoleTools(ctx,agent,binding,{files,transact:async()=>{throw Error('Unexpected generic transaction')},notifications:(snapshot,b)=>runtime.notifications(snapshot,b),claimNotifications:b=>runtime.consumeWakeSignals(b),consumeRecovery:(b,consume)=>runtime.consumeRecoveryMarker(b,consume),onError:()=>{}})
  return{name:binding.role,call:(name,input,callId)=>installed.get(name).execute(input,{agent,callId:callId??'actual-'+(++calls),signal:new AbortController().signal,concludeTurn(){}})}
 }
 const admit=async(paths,role='Planner')=>{
  const binding=bind(role),sources=[]
  for(const path of paths){const observed=await files.fileInfo(path);assert(observed);sources.push({path,version:observed.version})}
  const record={identity:binding,sessionId:'controlled-session',lastWake:{id:'original-wake',role,taskId:task.taskId,sources}}
  runtime.roleRecords.set(binding.workId,record);await records.set(runtime.prefix+'roles/'+hash(binding.workId),record)
  return toolsFor(binding)
 }
 return {directory,files,records,runtime,toolsFor,bind,admit}
}
function interruptRename(r,target){const rename=r.files.rename.bind(r.files);let hit=false;r.files.rename=async(a,b)=>{const result=await rename(a,b);if(b===target&&!hit&&result){hit=true;throw Error('controlled interruption after rename')}return result};return ()=>{r.files.rename=rename}}
function stopBeforeRename(r,target){const rename=r.files.rename.bind(r.files);r.files.rename=async(a,b)=>{if(b===target)throw Error('controlled interruption before rename');return rename(a,b)};return ()=>{r.files.rename=rename}}
async function plannerConsumesMarker(r){const planner=r.toolsFor(r.bind());const snapshot=await planner.call('dss_snapshot',{});await planner.call('dss_recovery_consume',{snapshotId:snapshot.snapshotId,continuation:'confirmed continuation\n'},'consume-stable')}
const publishMember=(r,id)=>r.runtime.publishPhysicalMemberRecovery(id,{taskId:task.taskId,member:'A'},{path:dailyDebug,text:'original diagnostic\n'},legacySignal)
const directInput={commandId:'original-input',taskId:task.taskId,markerPath:marker,signalPath:signal,debug:{path:debug,text:'original diagnostic\n'},recoveryInput:{path:inputPath,text:'original recovery input'}}
if(child){
 const phase=process.argv[4],r=await rig('process',phase!=='publish')
 if(phase==='publish'){
  const rename=r.files.rename.bind(r.files)
  r.files.rename=async(a,b)=>{const result=await rename(a,b);if(b===signal&&result){await fs.writeFile(path.join(root,'process-publish-sources.json'),JSON.stringify(Object.fromEntries(loaded)));process.exit(73)}return result}
  await publishMember(r,'process-member');throw Error('Expected process termination did not occur')
 }
 if(phase==='receive'){
  const planner=await r.admit([signal,marker]),view=await planner.call('dss_snapshot',{})
  await planner.call('dss_claim',{snapshotId:view.snapshotId})
  await planner.call('dss_recovery_consume',{snapshotId:view.snapshotId,continuation:'confirmed continuation\n'})
 }else{
  await publishMember(r,'process-member')
  check(await read(r.files,signal),undefined);check(await read(r.files,marker),undefined)
  check(await read(r.files,note),'original Memory\nconfirmed continuation\n')
  check(await read(r.files,debug),'original debug\noriginal diagnostic\n')
 }
 await r.files.close();hooks.deregister();console.log(JSON.stringify({phase,assertions,sourceHashes:Object.fromEntries(loaded)}));process.exit(0)
}
try{
 // Actual runtime publisher -> stored RoleRecord -> installed dss_claim and
 // Planner continuation -> cold retry. Source identity survives consumed signal.
 let r=await rig('consumed-signal'),undo=interruptRename(r,signal)
 await rejects(()=>publishMember(r,'accepted-member'),/after rename/);undo()
 check(JSON.parse(await read(r.files,operation('accepted-member')+'.json')).markerPublished,true)
 const planner=await r.admit([signal,marker]);const snapshot=await planner.call('dss_snapshot',{})
 await planner.call('dss_claim',{snapshotId:snapshot.snapshotId});check(await read(r.files,signal),undefined);check(await read(r.files,marker),'')
 await planner.call('dss_recovery_consume',{snapshotId:snapshot.snapshotId,continuation:'confirmed continuation\n'});check(await read(r.files,marker),undefined)
 await r.files.append(debug,'user debug after completed append\n')
 await r.files.close();r=await rig('consumed-signal',true)
 let evidenceReads=0;const evidence=r.runtime.physicalSignalSources.bind(r.runtime);r.runtime.physicalSignalSources=async p=>{evidenceReads++;return evidence(p)}
 await publishMember(r,'accepted-member');check(evidenceReads,1);check(await read(r.files,signal),undefined);check(await read(r.files,marker),undefined)
 check(await read(r.files,note),'original Memory\nconfirmed continuation\n');check(await read(r.files,debug),'original debug\noriginal diagnostic\nuser debug after completed append\n');await r.files.close();cases++

 // A successfully returned rename needs no receiver readback.
 r=await rig('normal');r.runtime.physicalSignalSources=async()=>{throw Error('Unexpected successful-publication source check')}
 await publishMember(r,'normal-member');check(await read(r.files,signal),'');check(await read(r.files,marker),'');await r.files.close();cases++

 // Fixed recovery marker is NOT an ordinary signal. If Planner consumes it
 // before the publisher can save its phase, its original publication remains
 // unknown. No fake marker ACK or source fallback is introduced.
 r=await rig('consumed-marker');undo=interruptRename(r,marker)
 await rejects(()=>publishMember(r,'marker-gap'),/after rename/);undo();await plannerConsumesMarker(r)
 check(await read(r.files,marker),undefined);await r.files.close();r=await rig('consumed-marker',true)
 r.runtime.physicalSignalSources=async()=>{throw Error('Marker must not use ordinary signal evidence')}
 await rejects(()=>publishMember(r,'marker-gap'),/not confirmed/)
 const uncertain=JSON.parse(await read(r.files,operation('marker-gap')+'.json'));check(uncertain.published,undefined);check(uncertain.markerPublished,undefined);check(await read(r.files,signal),undefined);check(await read(r.files,marker),undefined)
 // An unrelated Task can still publish; no global lock/safety-net pause.
 const other={...task,taskId:'10000000-0000-4000-8000-000000000002',sourcePath:'tasks/b.md'}
 await r.files.replace(paths.task(other.taskId),JSON.stringify(other));await r.files.replace(paths.inbox(other.taskId,'A'),'independent inbox')
 await r.runtime.publishPhysicalMemberRecovery('independent',{taskId:other.taskId,member:'A'});check(await read(r.files,paths.state('A',other.taskId)+'/recovery'),'')
 await r.files.close();cases++

 // An unused staged marker can reuse a fixed marker another recovery
 // already left pending. This is coalesced responsibility, not proof that our
 // own stage was published. Never overwrite that marker's identity.
 for(const cut of ['none','after-reuse-save','after-unused-stage-delete']){
  r=await rig('reuse-marker-'+cut);undo=stopBeforeRename(r,marker)
  await rejects(()=>publishPhysicalRecovery(r.files,directInput),/before rename/);undo()
  await r.runtime.publishPhysicalMemberRecovery('other-recovery',{taskId:task.taskId,member:'A'})
  const existing=(await r.files.fileInfo(marker)).version
  if(cut==='none'){
   await publishPhysicalRecovery(r.files,directInput);check((await r.files.fileInfo(marker)).version,existing)
  }else{
   const method=cut==='after-reuse-save'?'replace':'delete',actual=r.files[method].bind(r.files);let hit=false
   r.files[method]=async(p,...args)=>{const result=await actual(p,...args);if(!hit&&
    (method==='replace'&&p===operation(directInput.commandId)+'.json'&&JSON.parse(args[0]).markerReused
     ||method==='delete'&&p===operation(directInput.commandId)+'.marker.stage')){hit=true;throw Error('controlled reuse interruption')}return result}
   await rejects(()=>publishPhysicalRecovery(r.files,directInput),/reuse interruption/);r.files[method]=actual
   await plannerConsumesMarker(r);check(await read(r.files,marker),undefined)
   await r.files.close();r=await rig('reuse-marker-'+cut,true);await publishPhysicalRecovery(r.files,directInput)
   check(await read(r.files,marker),undefined)
  }
  const fact=JSON.parse(await read(r.files,operation(directInput.commandId)+'.json'))
  check(fact.markerReused,true);check(fact.markerPublished,undefined);check(fact.published,true)
  check(await read(r.files,operation(directInput.commandId)+'.marker.stage'),undefined);check(await read(r.files,signal),'')
  await r.files.close();cases++
 }

 // Each accepted staged target must remain present or have exact publication
 // evidence. Remove only its own stage after admission, with no target.
 for(const kind of ['input','marker','signal']){
  r=await rig('missing-'+kind);const target={input:inputPath,marker,signal}[kind];undo=stopBeforeRename(r,target)
  await rejects(()=>publishPhysicalRecovery(r.files,directInput),/before rename/);undo()
  await r.files.delete(operation(directInput.commandId)+'.'+kind+'.stage')
  await rejects(()=>publishPhysicalRecovery(r.files,directInput),/not confirmed/)
  check(await read(r.files,target),undefined);check(JSON.parse(await read(r.files,operation(directInput.commandId)+'.json')).published,undefined)
  if(kind!=='signal')check(await read(r.files,signal),undefined)
  check(await read(r.files,debug),'original debug\noriginal diagnostic\n');await r.files.close();cases++
 }

 // Already-renamed but subsequently edited input is preserved, not overwritten
 // on an uncertain retry. Identical bytes in a new inode are not its identity.
 for(const edit of ['user edit','original recovery input']){
  r=await rig('edited-'+hash(edit));undo=interruptRename(r,inputPath)
  await rejects(()=>publishPhysicalRecovery(r.files,directInput),/after rename/);undo();await r.files.replace(inputPath,edit)
  await r.files.close();r=await rig('edited-'+hash(edit),true)
  await rejects(()=>publishPhysicalRecovery(r.files,directInput),/not confirmed/);check(await read(r.files,inputPath),edit);check(await read(r.files,signal),undefined);check(await read(r.files,marker),undefined);await r.files.close();cases++
 }

 // Actual Host restoration manager caller preserves the original diagnostic
 // input and resolves its consumed Planner_Helper signal through the same source.
 r=await rig('host-manager')
 const row={key:'host-restoration',value:{commandId:'host-original',createdAt:'2026-11-08T10:00:00Z',input:{facts:'original Host fault',hypotheses:'original hypothesis',actionsTaken:'actual prior action',continuation:'original Task continuation'},managerPublications:[{taskId:task.taskId,member:'A',role:'Planner'}]}}
 const managerSignal=paths.state('A',task.taskId)+'/Planner_Helper'
 undo=interruptRename(r,managerSignal);await rejects(()=>r.runtime.publishPhysicalHostRestoration(row),/after rename/);undo()
 const manager=await r.admit([managerSignal]),managerView=await manager.call('dss_snapshot',{})
 await manager.call('dss_claim',{snapshotId:managerView.snapshotId})
 await r.files.close();r=await rig('host-manager',true);await r.runtime.publishPhysicalHostRestoration(row)
 check(await read(r.files,managerSignal),undefined);check(await read(r.files,marker),'')
 check(JSON.parse(await read(r.files,inputPath)),{...row.value.input,at:row.value.createdAt,debugPath:debug})
 check((await read(r.files,debug)).split('original Host fault').length-1,1);await r.files.close();cases++

 // A missing signal with no accepted receiver source remains unknown, and a
 // new identical empty file at that address is never mistaken for the old one.
 for(const recreated of [false,true]){
  r=await rig('unproven-signal-'+recreated);undo=interruptRename(r,signal)
  await rejects(()=>publishMember(r,'unproven-signal'),/after rename/);undo();await r.files.delete(signal)
  if(recreated)await r.files.replace(signal,'')
  await rejects(()=>publishMember(r,'unproven-signal'),/not confirmed/)
  check(await read(r.files,signal),recreated?'':undefined)
  check(JSON.parse(await read(r.files,operation('unproven-signal')+'.json')).published,undefined)
  await r.files.close();cases++
 }

 // Actual independent Node processes: terminate after signal rename, accept
 // and consume it in a second process, retry the original publication in a third.
 // This checks process interruption and persisted port facts, not power-loss fsync.
 for(const [phase,status]of [['publish',73],['receive',0],['retry',0]]){
  const result=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--child',root,phase],{encoding:'utf8'})
  assert.equal(result.status,status,result.stderr);assertions++
  const facts=phase==='publish'?JSON.parse(await fs.readFile(path.join(root,'process-publish-sources.json'),'utf8')):JSON.parse(result.stdout).sourceHashes
  for(const [name,digest]of Object.entries(facts))assert.equal(loaded.get(name),digest,'Child source changed: '+name)
  assertions++;processRuns.push({phase,exit:result.status,sourceFiles:Object.keys(facts).length,sourceHashesMatched:true})
 }
 cases++

 // An exact still-present target settles an interrupted rename, then its saved
 // phase is not a permanent version lock on later ordinary user edits.
 r=await rig('exact-input');undo=interruptRename(r,inputPath)
 await rejects(()=>publishPhysicalRecovery(r.files,directInput),/after rename/);undo();await publishPhysicalRecovery(r.files,directInput)
 await r.files.replace(inputPath,'later user input');await r.files.append(debug,'later user debug\n')
 await publishPhysicalRecovery(r.files,directInput);check(await read(r.files,inputPath),'later user input');check(await read(r.files,debug),'original debug\noriginal diagnostic\nlater user debug\n');await r.files.close();cases++

 // Consumption still owns only the exact original marker. Its successfully
 // saved Memory phase survives later ordinary edits and a newer recovery marker.
 r=await rig('consume-later-marker');await r.files.replace(marker,'')
 const remove=r.files.deleteObserved.bind(r.files);let removed=false
 r.files.deleteObserved=async(p,v,...rest)=>{const result=await remove(p,v,...rest);if(p===marker&&result&&!removed){removed=true;throw Error('interruption after marker deletion')}return result}
 await rejects(()=>plannerConsumesMarker(r),/after marker deletion/);r.files.deleteObserved=remove
 await r.files.replace(marker,'');const laterMarker=(await r.files.fileInfo(marker)).version
 await r.files.append(note,'user continuation edit\n');await r.files.close();r=await rig('consume-later-marker',true)
 await plannerConsumesMarker(r);check((await r.files.fileInfo(marker)).version,laterMarker)
 check(await read(r.files,note),'original Memory\nconfirmed continuation\nuser continuation edit\n');await r.files.close();cases++

 // A pending operation for one Task has no global wait on another Task.
 r=await rig('parallel-tasks')
 let release,entered;const waiting=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve}),rename=r.files.rename.bind(r.files)
 r.files.rename=async(a,b)=>{if(b===marker){entered();await gate}return rename(a,b)}
 const pending=publishMember(r,'held-marker');await waiting
 await r.files.replace(paths.task(other.taskId),JSON.stringify(other));await r.files.replace(paths.inbox(other.taskId,'A'),'independent inbox')
 await r.runtime.publishPhysicalMemberRecovery('other-during-held',{taskId:other.taskId,member:'A'})
 check(await read(r.files,paths.state('A',other.taskId)+'/recovery'),'');check(await read(r.files,marker),undefined)
 release();await pending;check(await read(r.files,marker),'');await r.files.close();cases++

 // Lost stage is not success for the continuation Memory or debug append.
 // Failure is injected at the durable prepared fact, before target rename.
 for(const kind of ['debug','memory']){
  r=await rig('missing-append-'+kind);if(kind==='memory')await r.files.replace(marker,'')
  const replace=r.files.replace.bind(r.files);let lost=false
  r.files.replace=async(p,text)=>{await replace(p,text);if(p.endsWith('.json')&&p.includes('/.recovery/')){const value=JSON.parse(text),prepared=kind==='debug'?value.debugPrepared:value.notePrepared;if(prepared&&!lost){lost=true;throw Error('prepared append interruption')}}}
  const action=()=>kind==='debug'?publishPhysicalRecovery(r.files,directInput):plannerConsumesMarker(r)
  await rejects(action,/prepared append interruption/);r.files.replace=replace
  const factPath=operation(kind==='debug'?directInput.commandId:'consume:agent-Planner:consume-stable')
  await r.files.delete(factPath+'.'+kind+'.stage')
  // dss_recovery_consume uses a stable original tool command on this rig.
  await rejects(action,/not confirmed/);check(await read(r.files,kind==='debug'?debug:note),kind==='debug'?'original debug\n':'original Memory\n')
  if(kind==='memory')check(await read(r.files,marker),'')
  await r.files.close();cases++
 }
 console.log(JSON.stringify({status:'passed',assertions,cases,processRuns,sourceHashes:Object.fromEntries(loaded),limits:'Linux actual files and full runtime/tool bodies. Technical record/native-admission ports controlled; cold reconstruction and three independent Node processes with a deliberate exit after rename; not power-loss durability. Consumed fixed marker before phase persistence deliberately remains unconfirmed. No native DSH, Windows, full typecheck, cross-process exclusion, migration or default cutover acceptance.'},null,2))
}finally{hooks.deregister();await fs.rm(root,{recursive:true,force:true})}
