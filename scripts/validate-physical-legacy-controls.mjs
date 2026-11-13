import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
// Actual legacy-control wrappers, dss_submit_task installation and physical files. Schema parsing
// and unrelated Markdown/skill dependencies are explicit stubs. No native DSH,
// Windows, full typecheck or production cutover is asserted by this script.
const sourceRoot=new URL('../src/',import.meta.url),loaded=new Map()
const data=text=>'data:text/javascript;base64,'+Buffer.from(text).toString('base64')
const hooks=registerHooks({resolve(specifier,context,next){
 if(specifier==='zod')return{url:data(`const z=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;if(k==='toJSONSchema')return ()=>({});return z},apply(){return z}});export {z}`),shortCircuit:true}
 if(specifier==='mdast-util-from-markdown')return{url:data(`export function fromMarkdown(){return {type:'root',children:[]}}`),shortCircuit:true}
 if(specifier.startsWith('.')&&context.parentURL?.startsWith(sourceRoot.href)&&specifier.endsWith('.js')){
 const url=new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
 if(url.href===new URL('framework/skills.ts',sourceRoot).href)return{url:data(`export const frameworkSkillIndexPath='skills/index.md';export function isFrameworkSkillDefinitionPath(){throw new Error('Skill definition outside this test')}export function prepareFrameworkSkillIndex(){throw new Error('Skills outside this test')}`),shortCircuit:true}
 if(existsSync(fileURLToPath(url)))return{url:url.href,shortCircuit:true}}
 return next(specifier,context)},load(url,context,next){if(url.startsWith(sourceRoot.href)&&url.endsWith('.ts')){const source=readFileSync(new URL(url),'utf8');loaded.set(url.slice(sourceRoot.href.length),createHash('sha256').update(source).digest('hex'));return{format:'module',source:stripTypeScriptTypes(source,{mode:'transform',sourceUrl:url}),shortCircuit:true}}return next(url,context)}})
const { PhysicalLocalFiles }=await import('../src/framework/physical-local-files.ts')
const { installFrameworkRoleTools,workerPaths }=await import('../src/framework/role-tools.ts')
const { paths }=await import('../src/framework/task-files.ts')
const {spawnSync}=await import('node:child_process')
const {FrameworkHostLoop}=await import('../src/framework/host-loop.ts')
const {FrameworkTransactions}=await import('../src/framework/command-transactions.ts')
const {taskInitializationFiles}=await import('../src/framework/task-files.ts')
const {resumeLegacyTask,answerLegacyTask}=await import('../src/framework/legacy-migration.ts')
const {routePhysicalLegacyTask,resumePhysicalLegacyPublication,isPhysicalLegacyPendingPath}=await import('../src/framework/physical-legacy-publication.ts')
const {legacyMigratedTaskId,LEGACY_BASELINE}=await import('../src/framework/legacy-record-export.ts')
const {legacyDeclaredArtifacts,listLegacyArtifactReferences}=await import('../src/framework/legacy-artifacts.ts')
const {encodeJson}=await import('../src/framework/task-files.ts')
const {taskHistoryChange}=await import('../src/framework/task-history.ts')
const {cancelPhysicalTask}=await import('../src/framework/physical-task-terminal.ts')
const {FrameworkCleaner}=await import('../src/framework/cleaner.ts')
const hash=x=>createHash('sha256').update(x).digest('hex')
const hostPath=new URL('./test-support/historical-55fe/installed-host.js',import.meta.url)
// The frozen shipped producer, not a rewritten fixture-to-manifest mapper.
const bundled=readFileSync(hostPath,'utf8')
assert.equal(hash(bundled),'5a84b25b7619486ea98e7e11b140d02c0a3848e48008ac3cc2dc71a2a5a5d47a')
const producerSource=bundled.slice(bundled.indexOf('async function prepareLegacyMigration('),bundled.indexOf('async function applyLegacyMigration('))
const produce=new Function('identity','hash12','legacyDeclaredArtifacts','legacyMigratedTaskId','encodeJson','utf8','decode','paths','workerPaths','prepareFrameworkSkillIndex','frameworkSkillIndexPath',producerSource+'\nreturn prepareLegacyMigration')(
 x=>x,hash,legacyDeclaredArtifacts,legacyMigratedTaskId,encodeJson,x=>Buffer.from(x),x=>Buffer.from(x).toString(),paths,workerPaths,
 async()=>({changes:[],issues:[]}), 'skills/index.md')
const manifestPath='technical/legacy-migrations/original-import/manifest.json'
const original={id:'old-task',request:'原始任务\r\nPreserve exact requirement.',continuation:'paused',original:{schemaVersion:1,id:'old-task',reports:{},delivery:{artifacts:[]}},participants:[{identity:'original-instance',continuation:'paused',original:{instance:'original-instance'},plan:{original:'plan'},children:[{id:'worker',contract:{old:'contract'},reports:[{old:'report'}],executions:[{old:'execution'}]}]}]}
// Synthetic two-question input checks publication mechanics only; original runtime coexistence is not established.
const waitOriginal={...original,continuation:'wait-user',waits:[{id:'q1',memberIdentity:'original-instance',question:'Original first question?',original:{q:1}},{id:'q2',memberIdentity:'original-instance',question:'Original second question?',original:{q:2}}],participants:[{...original.participants[0],continuation:'wait-user'}]}
const read=async(files,p)=>{const s=await files.snapshot();try{return await files.read(s,p)}finally{await s.release()}}
const json=async(files,p)=>JSON.parse(await read(files,p))
let assertions=0,interruptions=0,processInterruptions=0;const checks=[]
const check=(name,a,b)=>{assert.deepEqual(a,b,name);assertions++;checks.push(name)},rejects=async(name,f,re)=>{await assert.rejects(f,re,name);assertions++;checks.push(name)}
const transactions={run(){throw new Error('Generic transaction was called')}}
const sourceBytes=new Map()
async function seed(files,legacy=original,artifacts=[]){
 const legacyTasks=Array.isArray(legacy)?legacy:[legacy]
 const s=await files.snapshot();let result
 try{result=await produce({mode:'local',revision:'frozen-source',baseline:LEGACY_BASELINE,records:legacyTasks.map(task=>({key:'task:'+task.id,bytes:Buffer.from(encodeJson(task.original))})),texts:[],tasks:legacyTasks,issues:[]},files,s,{id:'original-import',owner:'A',members:{'original-instance':'A'},artifacts})}finally{await s.release()}
 for(const change of result.changes)await files.replace(change.path,change.bytes??change.content)
 const mapped=result.manifest.tasks[0]
 sourceBytes.set(files.directory,new Map([[mapped.recordPath,await read(files,mapped.recordPath)],[mapped.continuationPath,await read(files,mapped.continuationPath)],...result.manifest.records.map(row=>[row.path,undefined])]))
 for(const [p,v] of sourceBytes.get(files.directory))if(v===undefined)sourceBytes.get(files.directory).set(p,await read(files,p))
 return mapped.taskId
}
async function originals(files){for(const [p,v]of sourceBytes.get(files.directory)??[])check('Original bytes unchanged: '+p,await read(files,p),v)}
async function pending(files){const s=await files.snapshot();try{return(await files.listDirectory(s,'state/')).filter(e=>isPhysicalLegacyPendingPath(e.path)).map(e=>e.path)}finally{await s.release()}}
async function acceptedSources(files){try{return JSON.parse(await fs.readFile(path.join(files.directory,'.test-accepted-sources.json'),'utf8'))}catch(e){if(e.code==='ENOENT')return [];throw e}}
async function consume(files,p){const info=await files.fileInfo(p);assert(info);await fs.writeFile(path.join(files.directory,'.test-accepted-sources.json'),JSON.stringify([...await acceptedSources(files),{path:p,version:info.version}]));await files.deleteObserved(p,info.version)}
const sources=files=>()=>acceptedSources(files)
async function recover(files){for(const p of await pending(files))await resumePhysicalLegacyPublication(files,p,sources(files))}
const target={manifestPath,oldTaskId:'old-task',member:'A'}
async function resume(files,id='resume-original'){return resumeLegacyTask(files,transactions,id,target,sources(files))}
async function answer(files,q='q1',text='Original accepted answer',id='answer-'+q){return answerLegacyTask(files,transactions,id,{...target,waitId:q,answer:text},sources(files))}
async function route(files,route='P'){const tools=new Map(),agent={id:'fg',session:{}},ctx={on:()=>()=>{},effect:()=>{},systemPrompt:{section(){}},tools:{register:t=>tools.set(t.name,t)}}
 installFrameworkRoleTools(ctx,agent,{role:'Foreground',owner:'A',workId:'fg',executionId:'fg-exec'},{files,physicalSignalSources:sources(files),transact:async()=>{throw new Error('Generic route transaction was called')},notifications:async()=>[],claimNotifications:async()=>({signals:[]}),onError:()=>{}})
 const exec={agent,callId:'route-original',signal:new AbortController().signal,concludeTurn(){}}
 const view=await tools.get('dss_snapshot').execute({},exec)
 return tools.get('dss_submit_task').execute({snapshotId:view.snapshotId,name:'preserved',route,text:'Actual semantic choice',legacyTask:{manifestPath,oldTaskId:'old-task'}},exec)
}
function interrupt(files,mode){const replace=files.replace.bind(files),create=files.createIfAbsent.bind(files),rename=files.rename.bind(files),renameIfAbsent=files.renameIfAbsent.bind(files),update=files.update.bind(files);let hit=false
 const stop=()=>{hit=true;if(process.env.LEGACY_EXIT_PHASE==='1')process.exit(76);throw new Error('Controlled interruption: '+mode)}
 files.createIfAbsent=async(p,c)=>{const result=await create(p,c);if(!hit&&(mode==='control-accepted'&&p.startsWith('state/.Legacy_Control_')||mode==='route-accepted'&&p.startsWith('state/.Legacy_Route_')||mode==='route-metadata'&&/^tasks\/.*\.json$/.test(p)))stop();return result}
 files.replace=async(p,c)=>{await replace(p,c);if(hit)return;if(p.startsWith('state/.Legacy_')){const fact=JSON.parse(c);if(mode==='control-source-prepared'&&fact.sourcePrepared&&!fact.sourcePublished||mode==='control-materials'&&fact.materialsReady&&!fact.signal||mode==='route-inbox-prepared'&&fact.inboxPrepared&&!fact.inboxPublished||mode==='route-materials'&&fact.kind==='route'&&fact.materialsReady&&!fact.sourcePublished||mode==='route-source-saved'&&fact.kind==='route'&&fact.sourcePublished&&!fact.signal.published)stop()}}
 files.renameIfAbsent=async(a,b)=>{const result=await renameIfAbsent(a,b);if(!hit&&mode==='route-source-renamed'&&b.startsWith('tasks/'))stop();return result}
 files.rename=async(a,b)=>{const result=await rename(a,b);if(!hit&&mode==='signal-consumed'&&b.startsWith('state/')&&!b.startsWith('state/.')){await consume(files,b);stop()}return result}
 files.update=async(p,f)=>{const result=await update(p,f);if(!hit&&mode==='manifest-updated'&&p===manifestPath)stop();return result}
 return()=>{files.replace=replace;files.createIfAbsent=create;files.rename=rename;files.renameIfAbsent=renameIfAbsent;files.update=update;assert(hit,'Interruption not reached: '+mode);interruptions++}
}
function recorderTools(files,task){
 const tools=new Map(),agent={id:'recorder',session:{}},ctx={on:()=>()=>{},effect:()=>{},systemPrompt:{section(){}},tools:{register:t=>tools.set(t.name,t)}}
 installFrameworkRoleTools(ctx,agent,{role:'Recorder',owner:task.owner,taskId:task.taskId,workId:'recorder',executionId:'recorder-exec'},
  {files,notifications:async()=>[],claimNotifications:async()=>({signals:[]}),onError:()=>{},transact:async()=>{throw Error('Generic Recorder transaction')}})
 return (name,input,id=name)=>tools.get(name).execute(input,{agent,callId:id,signal:new AbortController().signal,concludeTurn(){}})
}
async function cleanTask(files,task){
 const state=new Map(),records={get:async k=>state.get(k),set:async(k,v)=>state.set(k,structuredClone(v))},errors=[]
 const cleaner=new FrameworkCleaner(files,transactions,async()=>{})
 const loop=new FrameworkHostLoop(files,transactions,records,{scope:'legacy-cleanup',member:'A',primary:true,instanceUUID:'10000000-0000-4000-8000-000000000001'},()=>['A'],{
  wake:async()=>false,executing:()=>false,releaseTask:async()=>{},error:e=>errors.push(e),observe:async()=>{},
  clean:async(task,snapshot,observation)=>(await cleaner.clean(task,observation)).status==='released'})
 loop.record={initial:{},completed:{}}
 const view=await files.snapshot();try{await loop.scanTask(task,view,performance.now())}finally{await view.release()}
 // Physical Host releases the accepted Task before serial Cleaner work. Its
 // scan starts that continuation asynchronously, so join the original work
 // rather than treating the initial scan return as completed cleanup.
 const deadline=performance.now()+5000
 try{while(await files.fileInfo(paths.task(task.taskId))){
  if(errors.length)throw new AggregateError(errors,'Actual Cleaner failed')
  if(performance.now()>deadline)throw Error('Actual Cleaner did not retire Task metadata')
  await new Promise(resolve=>setTimeout(resolve,1))
 }}finally{await loop.stop()}
 if(errors.length)throw new AggregateError(errors,'Actual Cleaner failed')
}
async function hostRecover(files){
 const state=new Map(),errors=[],wakes=[],storage={get:async k=>state.get(k),set:async(k,v)=>state.set(k,structuredClone(v))}
 const loop=new FrameworkHostLoop(files,transactions,storage,{member:'A',primary:true,scope:'legacy-test',instanceUUID:'10000000-0000-4000-8000-000000000001'},()=>['A'],{
  startup:async()=>{},observe:async()=>{},physicalSignalSources:sources(files),executing:()=>false,wake:async w=>{wakes.push(w);return false},
  initializeWorkspace:async()=>{},releaseTask:async()=>{},sealBusiness:async()=>{},clean:async()=>false,error:e=>errors.push(e)})
 try{await loop.start();await loop.firstPoll;await Promise.all(await loop.runSignalPoll())}finally{await loop.stop()}
 if(errors.length)throw new AggregateError(errors,'Actual Host recovery failed')
 return wakes
}
if(process.argv[2]==='--interrupt'){
 const files=new PhysicalLocalFiles(process.argv[3]);interrupt(files,process.argv[4]);
 if(process.argv[5]==='route')await route(files);else if(process.argv[5]==='answer')await answer(files,'q2','Second answer');else await resume(files)
 throw new Error('Process interruption not reached')
}
if(process.argv[2]==='--recover'){
 const files=new PhysicalLocalFiles(process.argv[3]);await hostRecover(files);check('Cold process Host retired exact pending',await pending(files),[]);await files.close();process.exit(0)
}
const serviceSource=readFileSync(new URL('framework/service.ts',sourceRoot),'utf8'),serviceJs=stripTypeScriptTypes(serviceSource,{mode:'transform'});loaded.set('framework/service.ts',hash(serviceSource))
const serviceMethod=serviceJs.slice(serviceJs.indexOf('    legacyControl('),serviceJs.indexOf('    participation(',serviceJs.indexOf('    legacyControl(')))
const {physicalControlSignalSources}=await import('../src/framework/physical-control-signal-sources.ts')
const {withSnapshot}=await import('../src/framework/transactions.ts'),{readJson}=await import('../src/framework/task-files.ts'),{z}=await import('zod')
const serviceDeps={PhysicalLocalFiles,physicalControlSignalSources,withSnapshot,readJson,resumeLegacyTask,answerLegacyTask,z}
const Service=new Function(...Object.keys(serviceDeps),'return class {\n'+serviceMethod+'\n}')(...Object.values(serviceDeps))
async function serviceControl(files,action='resume'){
 const access={connection:{files,transactions,records:{get:async()=>undefined},scope:'legacy-test',identity:{instanceUUID:'instance'},prepareWrite:async()=>{}}}
 const service=Object.assign(new Service(),{running:new Map([['local',{connection:{registration:{member:'A'}}}]]),serialMode:(_m,work)=>work(),assertOpen(){},access:async()=>access,checkScope:()=>{},foreground:(_a,work)=>work(),changed(){},view:async()=>({completed:true})})
 return service.legacyControl({mode:'local',storageScope:'legacy-test',commandId:'service-'+action,migrationId:'original-import',oldTaskId:'old-task',action,waitId:'q1',answer:'Service accepted answer'})
}
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'dss-legacy-controls-'));let serial=0
async function fixture(legacy=original,artifacts=[]){const files=new PhysicalLocalFiles(path.join(scratch,String(++serial)));const taskId=await seed(files,legacy,artifacts);return{files,taskId}}
try{
 // Retained real old manifests still expose archived bytes after SQL-writer removal.
 // Input is generated by the frozen shipped producer above, not a new map format.
 for(const body of [new Uint8Array([0,255,128,10]),new Uint8Array()]) {
  const artifact={id:'actual-old-output',path:'E:\\old-work\\output.bin',sha256:hash(body)}
  const captured={...original,original:{...original.original,delivery:{artifacts:[artifact]}}}
  const {files:pendingFiles}=await fixture(captured)
  const pendingSnapshot=await pendingFiles.snapshot()
  try { check('Original artifact declaration remains visible', (await listLegacyArtifactReferences(pendingFiles,pendingSnapshot,manifestPath))[0].status,'pending') }
  finally { await pendingSnapshot.release(); await pendingFiles.close() }
  const {files,taskId}=await fixture(captured,[{taskId:original.id,artifactId:artifact.id,sourcePath:artifact.path,bytes:body}])
  const inspect=async()=>{const snapshot=await files.snapshot();try{return await listLegacyArtifactReferences(files,snapshot,manifestPath)}finally{await snapshot.release()}}
  const archived=paths.archive(taskId)+'/legacy/artifacts/'+hash(artifact.path)+'/output.bin'
  const metadata='technical/artifacts/manifests/'+hash(archived)+'.json',manifestBefore=await read(files,manifestPath),metadataBefore=await read(files,metadata)
  const found=(await inspect())[0];check('Frozen producer binary/empty artifact is readable',[found.status,found.archivedPath],['archived',archived])
  await files.replace(archived,new Uint8Array([33]));const edited=(await inspect())[0]
  check('Current Local artifact edit stays accessible',[edited.status,edited.archivedPath],['archived',archived])
  await files.delete(archived);check('Missing actual old artifact remains unavailable',(await inspect())[0].status,'unavailable')
  check('Original migration references remain unchanged',await read(files,manifestPath),manifestBefore)
  check('Original captured artifact metadata remains unchanged',await read(files,metadata),metadataBefore)
  await originals(files);await files.close()
 }

 // Actual wrapper entrypoints and Foreground installed tool; manifest output
 // comes from the exact historical producer with controlled captured inputs.
 for(const routeName of ['P','O']){
  const{files,taskId}=await fixture();await resume(files)
  check('Resume restores original mapped identity',(await json(files,manifestPath)).tasks[0].taskId,taskId)
  const plan=paths.member(taskId,'A')+'/Plan.md';await files.replace(plan,'NEWER USER PLAN')
  await route(files,routeName)
  const task=await json(files,paths.task(taskId));check('Foreground keeps explicit route '+routeName,task.route,routeName)
  check('Newer plan preserved',await read(files,plan),'NEWER USER PLAN')
  check('Original request in source',(await read(files,task.sourcePath)).includes(original.request),true)
  check('Accepted original control retained',(await read(files,task.sourcePath)).includes('resume-original'),true)
  check('No pending after success',await pending(files),[])
  await consume(files,paths.state('A',taskId)+(routeName==='P'?'/Planner_Inbox':'/Organizer_Task'))
  await route(files,routeName);check('Route retry does not recreate consumed signal',await files.fileInfo(paths.state('A',taskId)+(routeName==='P'?'/Planner_Inbox':'/Organizer_Task')),undefined)
  await originals(files);await files.close()
 }
 const{files:wait,taskId:waitId}=await fixture(waitOriginal);await answer(wait);await route(wait)
 const task=await json(wait,paths.task(waitId)),initial=await read(wait,task.sourcePath),inbox=await read(wait,paths.inbox(waitId,'A'))
 await wait.append(task.sourcePath,'\nNEWER REQUIREMENT');await wait.replace(paths.member(waitId,'A')+'/Plan.md','NEW PLAN')
 await answer(wait,'q2','Second answer');const after=await read(wait,task.sourcePath)
 check('Current source is appended not replaced',after.startsWith(initial+'\nNEWER REQUIREMENT'),true)
 check('Existing current Inbox unchanged by answer',await read(wait,paths.inbox(waitId,'A')),inbox)
 check('Existing current Plan unchanged by answer',await read(wait,paths.member(waitId,'A')+'/Plan.md'),'NEW PLAN')
 await consume(wait,paths.state('A',waitId)+'/Planner_Foreground');await answer(wait,'q2','Second answer')
 check('Answer retry does not append twice',await read(wait,task.sourcePath),after)
 check('Answer retry keeps consumed signal absent',await wait.fileInfo(paths.state('A',waitId)+'/Planner_Foreground'),undefined)
 await rejects('Changed original answer rejected',()=>answer(wait,'q2','Changed answer'),/different accepted control/)
 await originals(wait);await wait.close()
 for(const mode of ['control-accepted','control-materials','manifest-updated','signal-consumed']){
  const{files}=await fixture();const reset=interrupt(files,mode);await rejects(mode,()=>resume(files),/Controlled interruption/);reset();await files.close()
  const cold=new PhysicalLocalFiles(files.directory);await recover(cold);check(mode+' cold pending retired',await pending(cold),[])
  const manifest=await json(cold,manifestPath);check(mode+' actual original resumed',manifest.tasks[0].continuation,'running')
  await resume(cold);check(mode+' same action retry stable',await pending(cold),[]);await cold.close()
 }
 for(const mode of ['route-accepted','route-inbox-prepared','route-materials','route-metadata','route-source-renamed','route-source-saved','manifest-updated','signal-consumed']){
  const{files,taskId}=await fixture();await resume(files);const reset=interrupt(files,mode);await rejects(mode,()=>route(files),/Controlled interruption/);reset();await files.close()
  const cold=new PhysicalLocalFiles(files.directory);await recover(cold);check(mode+' route cold pending retired',await pending(cold),[])
  check(mode+' route Task retained',(await json(cold,paths.task(taskId))).taskId,taskId)
  const source=await read(cold,'tasks/preserved_P.md');check(mode+' source contains original',source.includes(original.request),true)
  const inbox=await read(cold,paths.inbox(taskId,'A'));check(mode+' Inbox original once',inbox.split('## Preserved continuation').length-1,1)
  await cold.close()
 }
 // Different Tasks share one manifest but not a publication lane. Its atomic
 // single-file update must retain a concurrent change outside this Task.
 const{files:shared}=await fixture();const update=shared.update.bind(shared)
 shared.update=async(p,fn)=>update(p,b=>{if(p!==manifestPath)return fn(b);const value=JSON.parse(Buffer.from(b).toString());value.issues.push('other Task changed concurrently');return fn(Buffer.from(JSON.stringify(value)))})
 await resume(shared);check('Concurrent unrelated manifest field preserved',(await json(shared,manifestPath)).issues,['other Task changed concurrently']);await shared.close()
 const{files:ended,taskId:endedId}=await fixture();const closed={version:1,taskId:endedId,route:'P',owner:'A',status:'complete',sourcePath:'tasks/ended_P.md',archiveFolder:endedId}
 await ended.replace(paths.task(endedId),encodeJson(closed));await rejects('Ended current Task never reopened',()=>resume(ended),/closed/)
 await ended.delete(paths.task(endedId));const h=taskHistoryChange(closed);await ended.replace(h.path,h.content);await rejects('Cleaned historical Task never recreated',()=>resume(ended),/no longer open/);await ended.close()
 // Independent Tasks do not wait on another Task's held material write.
 const otherOriginal={...original,id:'other-task',original:{...original.original,id:'other-task'}}
 const{files:parallel,taskId:parallelId}=await fixture([original,otherOriginal])
 const createParallel=parallel.createIfAbsent.bind(parallel);let releaseParallel,enteredParallel
 const held=new Promise(r=>{enteredParallel=r}),release=new Promise(r=>{releaseParallel=r})
 parallel.createIfAbsent=async(p,c)=>{if(p===paths.member(parallelId,'A')+'/Plan.md'){enteredParallel();await release}return createParallel(p,c)}
 const blocked=resume(parallel);await held
 try{
  const independent=resumeLegacyTask(parallel,transactions,'resume-other',{...target,oldTaskId:'other-task'},sources(parallel))
  let timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Independent Task waited on held Task')),1500)})
  try{await Promise.race([independent,timeout])}finally{clearTimeout(timer)}
  check('Independent Task finished while other material was held',(await json(parallel,manifestPath)).tasks.find(t=>t.oldId==='other-task').continuation,'running')
 }finally{releaseParallel();await blocked;parallel.createIfAbsent=createParallel}
 check('Same shared manifest preserves both Task updates',(await json(parallel,manifestPath)).tasks.map(t=>t.continuation),['running','running']);await parallel.close()
 // Missing publication is UNKNOWN, not permission to recreate a consumed
 // signal. The original control and exact pending responsibility stay intact.
 const{files:unknown}=await fixture();let resetUnknown=interrupt(unknown,'signal-consumed');await rejects('Prepare unknown notification',()=>resume(unknown),/Controlled interruption/);resetUnknown()
 const unknownPending=(await pending(unknown))[0]
 await rejects('Missing stage without actual accepted-source proof stays unknown',()=>resumePhysicalLegacyPublication(unknown,unknownPending),/not confirmed/)
 check('Unknown retains original pending',await pending(unknown),[unknownPending])
 check('Unknown never recreates consumed notification',await unknown.fileInfo('state/Foreground_Legacy_original-import_'+legacyMigratedTaskId('original-import','old-task')),undefined)
 await recover(unknown);check('Actual accepted-source evidence finishes original action',await pending(unknown),[]);await unknown.close()
 // A prepared append rebuilds from current user bytes when its stage has not
 // been published; it never reapplies an older full source snapshot.
 const{files:newer,taskId:newerId}=await fixture(waitOriginal);await answer(newer);await route(newer)
 const newerTask=await json(newer,paths.task(newerId)),resetNewer=interrupt(newer,'control-source-prepared')
 await rejects('Interrupt current source append',()=>answer(newer,'q2','Second answer'),/Controlled interruption/);resetNewer()
 await newer.append(newerTask.sourcePath,'\nUSER WROTE LATER');await recover(newer)
 const newerSource=await read(newer,newerTask.sourcePath)
 check('Prepared append keeps newer user write',newerSource.includes('USER WROTE LATER'),true)
 check('Prepared append adds original answer once',newerSource.split('Second answer').length-1,1);await newer.close()
 // An answer arriving after an accepted but interrupted semantic route first
 // finishes that exact route, then supplements the now-current Task.
 const{files:later,taskId:laterId}=await fixture(waitOriginal);await answer(later)
 const resetLater=interrupt(later,'route-accepted');await rejects('Interrupt accepted route before later answer',()=>route(later),/Controlled interruption/);resetLater()
 await answer(later,'q2','Second answer');const laterTask=await json(later,paths.task(laterId))
 check('Later answer is present in current source',(await read(later,laterTask.sourcePath)).includes('Second answer'),true)
 check('Later answer clears only actual unfinished publications',await pending(later),[]);await later.close()
 // An existing mapped child stays the same child; a user answer has no root
 // completion, Recorder or Cleaner side effects.
 const{files:child,taskId:childId}=await fixture(waitOriginal);await answer(child);await route(child)
 const childTask={...await json(child,paths.task(childId)),parent:{taskId:'20000000-0000-4000-8000-000000000002',owner:'A',objectiveId:'original-objective'}}
 await child.replace(paths.task(childId),encodeJson(childTask));await answer(child,'q2','Second answer')
 check('Existing child parent identity remains',(await json(child,paths.task(childId))).parent,childTask.parent)
 const childView=await child.snapshot();try{check('Legacy answer emits no child Recorder/Cleaner',(await child.list(childView,'state/')).some(e=>/\/(?:Recorder|Cleaner)$/.test(e.path)),false)}finally{await childView.release()}
 await child.close()
 // Metadata is visible after the current Recorder Cache can locate all
 // actual original input. Terminal recovery never races Cleaner with late work.
 for(const routeName of ['P','O'])for(const cleanerFirst of [false,true]){
  const{files,taskId}=await fixture();await resume(files);const oldInbox=await read(files,paths.inbox(taskId,'A'))
  if(routeName==='O')await files.replace(paths.run(taskId)+'/Organizer_Note.md','CURRENT ORGANIZER NOTE')
  const reset=interrupt(files,'route-metadata');await rejects('Interrupt '+routeName+' metadata before cancellation',()=>route(files,routeName),/Controlled interruption/);reset()
  await cancelPhysicalTask(files,{taskId},'A','actual-user-cancel',sources(files))
  const terminal=await json(files,paths.task(taskId)),call=recorderTools(files,terminal),view=await call('dss_snapshot',{}),mapped=(await json(files,manifestPath)).tasks[0]
  const continuation=await call('dss_read',{snapshotId:view.snapshotId,path:mapped.continuationPath})
  check(routeName+' Recorder can read original requirement before source publication',JSON.parse(continuation.text).request,original.request)
  const ownInput=routeName==='P'?paths.inbox(taskId,'A'):paths.run(taskId)+'/Organizer_Note.md'
  const own=await call('dss_read',{snapshotId:view.snapshotId,path:ownInput})
  check(routeName+' Recorder sees accepted routing decision',own.text.includes('Actual semantic choice'),true)
  if(routeName==='O'){
   check('O route keeps existing member Inbox unchanged',await read(files,paths.inbox(taskId,'A')),oldInbox)
   check('O route appends without replacing current Organizer Note',own.text.startsWith('CURRENT ORGANIZER NOTE'),true)
  }
  const sharedOriginal=await call('dss_read',{snapshotId:view.snapshotId,path:manifestPath})
  check('Recorder uses the exact shared reference without an extra Cache admission test',sharedOriginal.text,await read(files,manifestPath))
  const archive=paths.archive(terminal),recordText='Controlled Recorder: task cancelled before its initial business dispatch. Original requirement and actual selected route retained.'
  if(!cleanerFirst)await recover(files)
  await call('dss_recorder_save',{snapshotId:view.snapshotId,outputs:[{path:archive+'/records.md',text:recordText}],retainedPaths:[mapped.recordPath,mapped.continuationPath,ownInput]})
  await cleanTask(files,terminal)
  if(cleanerFirst)await recover(files)
  check(routeName+' terminal route does not recreate Task source after Cleaner',await read(files,terminal.sourcePath),undefined)
  check(routeName+' terminal route does not recreate runtime metadata',await read(files,paths.task(taskId)),undefined)
  check(routeName+' actual Recorder archive retained',await read(files,archive+'/records.md'),recordText)
  check(routeName+' terminal publication retires only its exact pending',await pending(files),[])
  const retention=await json(files,archive+'/retention.json')
  check(routeName+' retained owning-role input keeps exact choice',(await read(files,retention.relocatedReferences[ownInput])).includes('Actual semantic choice'),true)
  check(routeName+' preserved old requirement survives actual Cleaner',JSON.parse(await read(files,mapped.continuationPath)).request,original.request)
  await files.close()
 }
 const{files:superseded,taskId:supersededId}=await fixture(waitOriginal);await answer(superseded);await route(superseded)
 const resetSuperseded=interrupt(superseded,'control-accepted');await rejects('Accept answer then interrupt before delivery',()=>answer(superseded,'q2','Second answer'),/Controlled interruption/);resetSuperseded()
 await cancelPhysicalTask(superseded,{taskId:supersededId},'A','later-user-cancel',sources(superseded));await recover(superseded)
 const supersededPath=manifestPath.replace('manifest.json','controls/'+hash('old-task\0A\0answer\0q2')+'.json'),savedAnswer=await json(superseded,supersededPath)
 check('Later cancellation preserves exact unanswered input',savedAnswer.answer,'Second answer')
 check('Later cancellation records actual supersession instead of delivery',savedAnswer.supersededBy.status,'cancelled')
 check('Later cancellation emits no new Planner notice',await superseded.fileInfo(paths.state('A',supersededId)+'/Planner_Foreground'),undefined)
 check('Superseded control owns no lingering publication',await pending(superseded),[]);await superseded.close()
 // The actual FrameworkService method reaches both physical wrapper branches.
 for(const action of ['resume','answer']){const{files}=await fixture(action==='answer'?waitOriginal:original);check('Actual service '+action+' succeeds',await serviceControl(files,action),{completed:true});check('Actual service '+action+' retires pending',await pending(files),[]);await originals(files);await files.close()}
 // Existing admitted Task source append interruption, followed by current input.
 for(const mode of ['control-source-prepared','manifest-updated','signal-consumed']){
  const{files,taskId}=await fixture(waitOriginal);await answer(files);await route(files)
  const t=await json(files,paths.task(taskId)),before=await read(files,t.sourcePath),reset=interrupt(files,mode)
  await rejects('Existing answer '+mode,()=>answer(files,'q2','Second answer'),/Controlled interruption/);reset();await files.close()
  const cold=new PhysicalLocalFiles(files.directory);await hostRecover(cold);const after=await read(cold,t.sourcePath)
  check('Existing answer '+mode+' appended once',after.split('Second answer').length-1,1)
  check('Existing answer '+mode+' preserved initial source',after.startsWith(before),true)
  await answer(cold,'q2','Second answer');check('Existing answer '+mode+' replay stable',await read(cold,t.sourcePath),after);await cold.close()
 }
 // Real Node process loss at accepted command, mapped metadata, and consumed
 // notification boundaries. A new process runs actual Host state discovery.
 for(const [phase,operation]of [['control-accepted','resume'],['route-metadata','route'],['signal-consumed','route']]){
  const{files,taskId}=await fixture();if(operation==='route')await resume(files);const directory=files.directory;await files.close()
  const crashed=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(import.meta.url),'--interrupt',directory,phase,operation],{encoding:'utf8',env:{...process.env,LEGACY_EXIT_PHASE:'1'}})
  check('Real process exit '+phase,[crashed.status,crashed.stderr],[76,'']);processInterruptions++
  const recovered=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(import.meta.url),'--recover',directory],{encoding:'utf8'})
  check('New process actual Host recovery '+phase,[recovered.status,recovered.stderr],[0,''])
  const cold=new PhysicalLocalFiles(directory);check('Process recovery leaves no temporary pending '+phase,await pending(cold),[])
  if(operation==='route')check('Process recovery preserves mapped Task '+phase,(await json(cold,paths.task(taskId))).taskId,taskId)
  await cold.close()
 }
 // A name collision or current terminal state is not permission to overwrite.
 const{files:collision,taskId:collisionId}=await fixture();await resume(collision);await collision.replace('tasks/preserved_P.md','ANOTHER USER TASK')
 await rejects('Actual Foreground rejects occupied source',()=>route(collision),/filename already exists/)
 check('Occupied source retained',await read(collision,'tasks/preserved_P.md'),'ANOTHER USER TASK');check('Collision creates no mapped metadata',await read(collision,paths.task(collisionId)),undefined);await collision.close()
 console.log(JSON.stringify({status:'passed',assertions,interruptions,processInterruptions,checks,producer:{hostSha256:hash(bundled),functionSha256:hash(producerSource)},sourceHashes:Object.fromEntries(loaded),limits:'Actual production wrappers/installed Foreground and physical files. Exact retained shipped manifest producer with controlled captured old inputs; unrelated skill index/schema/native adapters stubbed. Actual service method with controlled connection/view, actual Host discovery, cold handle and three real Node exit/restart boundaries; not OS durability, native DSH, Windows, actual user data, full tsc or default cutover acceptance.'},null,2))
}finally{hooks.deregister();await fs.rm(scratch,{recursive:true,force:true})}
