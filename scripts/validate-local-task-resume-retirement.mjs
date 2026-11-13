import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module'
// Actual installed tools, real Zod schemas and physical files. Only unrelated
// Markdown/skill dependencies and external execution seams are controlled. No native DSH,
// Windows, full typecheck or production cutover is asserted by this script.
const cases=['plan-before','plan-after','stage-before','stage-after','rename-before','rename-after','destination-before','unknown-consumed']
if(!process.env.DSS_RESUME_CASE){
 const results=cases.map(boundary=>JSON.parse(execFileSync(process.execPath,[fileURLToPath(import.meta.url)],{encoding:'utf8',env:{...process.env,DSS_RESUME_CASE:boundary,DSS_TEST_RESUME_BOUNDARY:boundary},maxBuffer:8*1024*1024})))
 console.log(JSON.stringify({status:'passed',assertions:results.reduce((sum,value)=>sum+value.assertions,0),cases:results,limits:'Actual registered tools, real Zod/SDK/physical files and actual Recorder→Host/Cleaner. Native lifecycle/notification/admission ports remain explicit fixtures, not full DSH or Windows.'},null,2));process.exit(0)
}
assert(cases.includes(process.env.DSS_RESUME_CASE))
const sourceRoot=new URL('../src/',import.meta.url),loaded=new Map()
const require=createRequire(import.meta.url),zodPath=require.resolve(process.env.DSS_ZOD_MODULE ?? 'zod'),zod=require(zodPath)
const data=text=>'data:text/javascript;base64,'+Buffer.from(text).toString('base64')
const hooks=registerHooks({resolve(specifier,context,next){
 if(specifier==='zod')return{url:pathToFileURL(zodPath).href,shortCircuit:true}
 if(specifier==='mdast-util-from-markdown')return{url:data(`export function fromMarkdown(text){if(text.includes('['))throw new Error('Markdown links outside this test');return {type:'root',children:[]}}`),shortCircuit:true}
 if(specifier.startsWith('.')&&context.parentURL?.startsWith(sourceRoot.href)&&specifier.endsWith('.js')){
 const url=new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
 if(url.href===new URL('framework/skills.ts',sourceRoot).href)return{url:data(`export const frameworkSkillIndexPath='skills/index.md';export function isFrameworkSkillDefinitionPath(){throw new Error('Skill definition outside this test')}export function prepareFrameworkSkillIndex(){throw new Error('Skills outside this test')}`),shortCircuit:true}
 if(existsSync(fileURLToPath(url)))return{url:url.href,shortCircuit:true}}
 return next(specifier,context)},load(url,context,next){if(url.startsWith(sourceRoot.href)&&url.endsWith('.ts')){const source=readFileSync(new URL(url),'utf8');loaded.set(url.slice(sourceRoot.href.length),createHash('sha256').update(source).digest('hex'));return{format:'module',source:stripTypeScriptTypes(source,{mode:'transform',sourceUrl:url}),shortCircuit:true}}return next(url,context)}})
const {FrameworkCleaner}=await import('../src/framework/cleaner.ts')
const {FrameworkHostLoop}=await import('../src/framework/host-loop.ts')
const {cancelPhysicalTask}=await import('../src/framework/physical-task-terminal.ts')
const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {installFrameworkRoleTools}=await import('../src/framework/role-tools.ts')
const {ExecutionControls}=await import('../src/framework/execution-control.ts')
const {GitAuthorityStore}=await import('../src/framework/git-authority.ts')
const {foregroundFullGuide}=await import('../src/framework/role-prompts.ts')
const {upgradeForegroundGuide}=await import('../src/framework/foreground-guide-upgrade.ts')
const {paths,readJson,taskLifecycle}=await import('../src/framework/task-files.ts')
const {withSnapshot}=await import('../src/framework/transactions.ts')
const {readTaskCleanupRecord}=await import('../src/framework/cleaner.ts')
const {publishTaskResume}=await import('../src/framework/task-resume.ts')
const root=await fs.mkdtemp(path.join(os.tmpdir(),'dss-control-tool-path-')),files=new PhysicalLocalFiles(root)
const read=p=>withSnapshot(files,s=>files.read(s,p))
const sdkHooks=await import('./test-support/dsh-sdk-runtime.mjs')
const {openDshStorageFixture}=await import('./test-support/dsh-sdk-storage.mjs')
const sdk=await openDshStorageFixture(path.join(root,'sdk-records'),path.join(root,'sdk-locator')),store=sdk.adapter
const controls=new ExecutionControls(store,'tool-path',()=> '2026-11-09T00:00:00.000Z',files,store,'instance')
const ids=['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002']
const tasks=ids.map(taskId=>({version:1,taskId,route:'P',owner:'A',members:['A'],status:'running',sourcePath:'tasks/source_'+taskId+'_P.md'}))
let assertions=0
const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
const rejects=async(fn,re)=>{await assert.rejects(fn,re);assertions++}
const runtimeSource=readFileSync(new URL('../src/framework/role-runtime.ts',import.meta.url),'utf8')
loaded.set('framework/role-runtime.ts',createHash('sha256').update(runtimeSource).digest('hex'))
const start=runtimeSource.indexOf('      taskControl: {',runtimeSource.indexOf('  private services()')),end=runtimeSource.indexOf('\n      cancelTask:',start)
assert(start>0&&end>start)
const literal=stripTypeScriptTypes('const services={'+runtimeSource.slice(start,end)+'};',{mode:'transform'})
const runtime={files,controls,records:store,config:{primary:true,member:'A',collaborationId:'collab'},roleRecords:new Map(),stopOperations:new Map(),transactions:{run(){throw Error('No generic Local transaction')}},archiveHostKey:()=> 'test-host',taskControlPublished:async()=>{},scheduleTaskResume:(...args)=>scheduled.push(args)}
const dependencies={PhysicalLocalFiles,GitAuthorityStore,withSnapshot,readTaskCleanupRecord,readJson,paths,taskLifecycle,publishTaskResume}
const taskControl=new Function(...Object.keys(dependencies),literal+'return services.taskControl;').call(runtime,...Object.values(dependencies))
const binding={role:'Foreground',owner:'A',member:'A',workId:'Foreground',executionId:'fg-execution',collaborationId:'collab',recordPath:'state/foreground/Foreground_Memory.md'}
runtime.roleRecords.set(binding.workId,{identity:{role:'Foreground',executionId:binding.executionId},sessionId:'fixture-session',generation:1})
const scheduled=[],effects=[]
function install(b,control=taskControl){
 const tools=new Map(),sections=[],agent={id:'agent-'+b.role,session:{}},ctx={on:()=>()=>{},effect:fn=>effects.push(fn),systemPrompt:{section:s=>sections.push(s)},tools:{register:t=>tools.set(t.name,t)}}
 installFrameworkRoleTools(ctx,agent,b,{files,taskControl:control,notifications:async()=>[],claimNotifications:async()=>({signals:[]}),transact:async()=>{throw Error('No generic transaction')},onError:e=>{throw e}})
 return{tools,sections,call:async(name,input,id=name)=>{const tool=tools.get(name);const validated=tool.parameters?.parse?tool.parameters.parse(input):input;return tool.execute(validated,{agent,callId:id,signal:new AbortController().signal,concludeTurn:()=>events.push('Recorder-turn-concluded')})}}
}
const {physicalControlSignalSources}=await import('../src/framework/physical-control-signal-sources.ts')
runtime.physicalSignalSources=physicalControlSignalSources(store,'tool-path','A')
const events=[]
try{
if(process.env.DSS_RESUME_CASE==='unknown-consumed'){

 for(const task of tasks){task.route='O';await files.replace(paths.task(task.taskId),JSON.stringify(task));await files.replace(paths.run(task.taskId)+'/Organizer_Note.md','Original retained work');await controls.setTask('pause-'+task.taskId,task.taskId,'paused')}
 const fg=install(binding),viewA=await fg.call('dss_snapshot',{taskId:tasks[0].taskId}),viewB=await fg.call('dss_snapshot',{taskId:tasks[1].taskId})
 const input=(view,taskId)=>({snapshotId:view.snapshotId,path:view.taskControlPath,append:false,text:JSON.stringify({taskId,intent:'running'})})
 const rename=files.rename.bind(files),unknown=new Error('Original resume rename result unknown'),emitted=[],sources=physicalControlSignalSources(store,'tool-path','A')
 let release,enter,held=false;const entered=new Promise(r=>enter=r),barrier=new Promise(r=>release=r)
 files.rename=async(from,to)=>{if(from.includes('/.user-resume-')&&from.startsWith(paths.run(tasks[0].taskId)+'/')&&!held){held=true;enter();await barrier;const moved=await rename(from,to);if(moved)emitted.push(to);throw unknown}const moved=await rename(from,to);if(moved&&from.includes('/.user-resume-'))emitted.push(to);return moved}
 const original=fg.call('dss_record',input(viewA,tasks[0].taskId),'original-unknown');original.catch(()=>{})
 await entered
 await fg.call('dss_record',input(viewB,tasks[1].taskId),'independent-B')
 check(emitted.length,1);check(emitted[0].startsWith(paths.state('A',tasks[1].taskId)+'/'),true)
 release();await rejects(()=>original,e=>e===unknown)
 check(emitted.length,2)
 const requests=[],hostErrors=[],host=new FrameworkHostLoop(files,{},store,{member:'A',primary:true,scope:'tool-path',instanceUUID:'instance'},()=>['A'],{executing:()=>false,wake:async request=>{requests.push(request);return true},error:e=>hostErrors.push(String(e))})
 await withSnapshot(files,snapshot=>host.scanTask(tasks[0],snapshot,performance.now()));check(hostErrors,[]);check(requests.length,1)
 const source=requests[0].sources[0],workId=JSON.stringify(['Organizer',tasks[0].taskId,null,null]),key='framework-runtime/'+createHash('sha256').update('tool-path').digest('hex')+'/roles/'+createHash('sha256').update(workId).digest('hex')
 // The accepted new role is the native-admission boundary input; the source
 // identity itself comes from actual Host discovery of the original signal.
 await store.set(key,{identity:{workId,executionId:'accepted-organizer',role:'Organizer',taskId:tasks[0].taskId},lastWake:requests[0]})
 check(await files.deleteObserved(source.path,source.version),true);check(await read(source.path),undefined)
 check(await sources(source.path),[source])
 const retry=await fg.call('dss_record',input(viewA,tasks[0].taskId),'original-unknown')
 check(retry.commandId,'agent-Foreground:original-unknown');check(emitted.length,2)
 check(await read(source.path),undefined)
 const suffix=createHash('sha256').update('agent-Foreground:original-unknown').digest('hex'),stem=paths.run(tasks[0].taskId)+'/.user-resume-'+suffix
 check(await read(stem+'.json'),undefined);check(await read(stem+'-0.stage'),undefined)
 check(await controls.resumeHandled('agent-Foreground:original-unknown',tasks[0]),true)
 await fg.call('dss_record',input(viewA,tasks[0].taskId),'original-unknown');check(emitted.length,2)
 check(JSON.parse(await read(paths.task(tasks[0].taskId))),tasks[0])
 console.log(JSON.stringify({status:'passed',assertions,events,emitted,source,hostErrors,case:process.env.DSS_RESUME_CASE,scope:'Actual registered Foreground controls, real Zod and extracted Runtime writer -> real Local control file/Task resume publisher. Held original rename result, independent Task B, actual Host scan/wake source, accepted-role boundary input and exact deleteObserved consumption, real physicalControlSignalSources lookup, original UNKNOWN and same-command replay without re-emission. Native admission and native admission is controlled; record store uses actual DSH SDK, not full DSH.',sourceSha256:Object.fromEntries(loaded)},null,2))

}else{

 const original={...tasks[0],route:'O'}
 await files.replace(paths.task(original.taskId),JSON.stringify(original));await files.replace(paths.run(original.taskId)+'/Organizer_Note.md','original Task')
 await controls.setTask('pause-before-resume',original.taskId,'paused')
 const fg=install(binding),view=await fg.call('dss_snapshot',{taskId:original.taskId})
 let enter,release;const entered=new Promise(r=>enter=r),held=new Promise(r=>release=r),update=files.updateInExistingDirectory.bind(files),rename=files.rename.bind(files),mkdir=fs.mkdir
 const boundary=process.env.DSS_TEST_RESUME_BOUNDARY??'plan-before'
 let publication,stalled=false
 const wait=async phase=>{if(boundary===phase&&!stalled){stalled=true;events.push(phase);enter();await held}}
 files.updateInExistingDirectory=async(p,...args)=>{
  if(p.includes('/.user-resume-')&&p.endsWith('.json')){publication=p;await wait('plan-before');const result=await update(p,...args);await wait('plan-after');return result}
  if(p.includes('/.user-resume-')&&p.endsWith('.stage')){await wait('stage-before');const result=await update(p,...args);await wait('stage-after');return result}
  return update(p,...args)
 }
 files.rename=async(from,to)=>{if(from.includes('/.user-resume-')){await wait('rename-before');const result=await rename(from,to);await wait('rename-after');return result}return rename(from,to)}
 fs.mkdir=async(p,...args)=>{if(p===path.join(root,paths.state('A',original.taskId)))await wait('destination-before');return mkdir(p,...args)}
 const resume=fg.call('dss_record',{snapshotId:view.snapshotId,path:view.taskControlPath??taskControl.path,append:false,text:JSON.stringify({taskId:original.taskId,intent:'running'})},'resume-racing-cleanup')
 resume.catch(()=>{})
 await entered
 await cancelPhysicalTask(files,{taskId:original.taskId},'A','cancel-during-resume')
 const terminal=JSON.parse(await read(paths.task(original.taskId)));check(terminal.status,'cancelled')
 const cleaner=new FrameworkCleaner(files,{run(){throw Error('Local Cleaner cannot use generic transaction')}})
 const recorder=install({...binding,role:'Recorder',taskId:original.taskId,workId:'Recorder-'+original.taskId,executionId:'recorder-execution'})
 const recorderView=await recorder.call('dss_snapshot',{})
 const archive=await recorder.call('dss_recorder_save',{snapshotId:recorderView.snapshotId,outputs:[{path:recorderView.archiveRecordsPath,text:'Cancelled Task, preserved original request.'}],retainedPaths:[]},'recorder-after-cancel')
 check(archive.saved,true);check(await read(paths.state('A',original.taskId)+'/Cleaner'),'')
 events.push('actual-Recorder-published-Cleaner')
 // Use the real Host scan to observe that published notice and create its
 // cleanup responsibility. Native resource ports remain controlled.
 const loop=Object.create(FrameworkHostLoop.prototype)
 Object.assign(loop,{files,identity:{member:'A'},physicalCleanupOperations:new Map(),physicalReleased:new Set(),physicalCleanupAwaitingRelease:new Set(),taskOperations:new Set(),record:{completed:{},initial:{}},actions:{clean:async(task,snapshot,observation)=>(await cleaner.clean(task,observation)).status==='released',error:e=>{throw e}},runOperation:fn=>fn(),startPhysicalRelease:key=>{events.push('independent-resource-release-started');loop.physicalReleased.add(key)},finishPhysicalRelease:async()=>{},save:async()=>events.push('cleanup-completion-saved')})
 await withSnapshot(files,snapshot=>loop.scanTask(terminal,snapshot,performance.now()))
 check(await read(paths.task(original.taskId)),undefined)
 check(await read(publication),undefined)
 events.push('Host-directory-and-metadata-cleaned')
 release()
 let outcome
 try{outcome={returned:await resume}}catch(error){outcome={error:String(error)}}
 fs.mkdir=mkdir
 const after=await read(publication),runExists=!!await files.entryInfo(paths.run(original.taskId))
 check(runExists,false);check(await files.entryInfo(paths.state('A',original.taskId)),undefined);check(after,undefined);check(!!outcome.error,boundary!=='plan-after')
 console.log(JSON.stringify({assertions,boundary,events,outcome,orphanPath:publication,publicationAfterCleanup:after===undefined?null:JSON.parse(after),stateAfterCleanup:await files.entryInfo(paths.state('A',original.taskId))??null,case:process.env.DSS_RESUME_CASE,scope:'Actual registered dss_record -> extracted original Runtime control writer -> actual publishPhysicalResume; actual cancelPhysicalTask -> actual registered dss_recorder_save/publishPhysicalRecorder -> actual Host.scanTask/observeCleanup/continuePhysicalCleanup and Cleaner. Notification and native-resource ports controlled; no full Recorder AI/native DSH session or user-device claim.',sourceSha256:Object.fromEntries(loaded)},null,2))

}
}finally{for(const effect of effects){const dispose=effect();if(typeof dispose==='function')await dispose()}await files.close();await sdk.close();sdkHooks.hooks.deregister();hooks.deregister();await fs.rm(root,{recursive:true,force:true})}
