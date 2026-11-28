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
const { PhysicalLocalFiles }=await import('../src/framework/physical-local-files.ts')
const { installFrameworkRoleTools,workerPaths }=await import('../src/framework/role-tools.ts')
const { paths }=await import('../src/framework/task-files.ts')
const { TaskWorkspaces }=await import('../src/framework/task-workspace.ts')
let assertions=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++};const rejects=async(f,re)=>{await assert.rejects(f,re);assertions++}
const root=await fs.mkdtemp(path.join(os.tmpdir(),'dss-role-records-')),files=new PhysicalLocalFiles(root)
const read=async p=>{const s=await files.snapshot();try{return await files.read(s,p)}finally{await s.release()}}
const task={version:1,taskId:'10000000-0000-4000-8000-000000000001',route:'P',owner:'A',members:['A'],status:'running',sourcePath:'tasks/a.md'}
await files.replace(paths.task(task.taskId),JSON.stringify(task));await files.replace(task.sourcePath,'Original requirement')
let calls=0
function role(roleName,extra={},services={}){
 const tools=new Map(),events=[],agent={id:'agent-'+roleName,session:{snapshotEvents:()=>events}},ctx={on:()=>()=>{},effect:()=>{},sessions:{flush:async()=>{}},systemPrompt:{section(){}},tools:{register:t=>tools.set(t.name,t)}}
 const binding={role:roleName,taskId:task.taskId,owner:'A',member:'A',workId:'work-'+roleName,executionId:'execution-'+roleName,...extra}
 installFrameworkRoleTools(ctx,agent,binding,{files,transact:async()=>{throw new Error('Unexpected generic transaction')},notifications:async()=>[],claimNotifications:async()=>({signals:[]}),onError:()=>{},...services})
 let ended=0
 return {get ended(){return ended},call:(name,input,signal=new AbortController().signal)=>{const callId='call-'+(++calls);events.push({type:'tool/call',data:{name,callId,arguments:JSON.stringify(input)}});return tools.get(name).execute(input,{agent,callId,signal,concludeTurn:()=>ended++})},binding}
}
try{
 const planner=role('Planner'),note=paths.member(task.taskId,'A')+'/Planner_Memory.md'
 const assignedSnapshot=await planner.call('dss_snapshot',{})
 await planner.call('dss_worker_assign',{snapshotId:assignedSnapshot.snapshotId,childId:'actual-worker',contract:'Original Worker contract',decision:'Assignment decision\n'})
 const assigned=workerPaths(task.taskId,'A','actual-worker')
 check(await read(assigned.contract),'Original Worker contract')
 check(await read(assigned.notes),'');check(await read(assigned.reply),'')
 check(await read(paths.state('A',task.taskId)+'/Worker_actual-worker'),'')
 check((await read(note)).startsWith('Assignment decision\n'),true)
 await files.replace(note,'')

 const view=await planner.call('dss_snapshot',{})
 await planner.call('dss_record',{snapshotId:view.snapshotId,path:note,text:'first\n',append:true});check(await read(note),'first\n')
 const originalRead=files.read.bind(files);files.read=async(s,p)=>{if(p===note)throw new Error('Append must not read/rewrite the old record');return originalRead(s,p)}
 await planner.call('dss_record',{snapshotId:view.snapshotId,path:note,text:'second\n',append:true});files.read=originalRead;check(await read(note),'first\nsecond\n')
 await planner.call('dss_record',{snapshotId:view.snapshotId,path:note,text:'replacement\r\n',append:false});check(await read(note),'replacement\r\n')
 await Promise.all(Array.from({length:8},(_,i)=>planner.call('dss_record',{snapshotId:view.snapshotId,path:note,text:String(i),append:true})))
 check((await read(note)).slice('replacement\r\n'.length).split('').sort().join(''),'01234567')
 await rejects(()=>planner.call('dss_record',{snapshotId:view.snapshotId,path:'skills/unowned.md',text:'bad',append:false}),/owned by this role/);check(await read('skills/unowned.md'),undefined)
 const worker=role('Worker',{workerId:'w1'},{workerBusiness:{assertLive(){},async assert(){}}}),workerView=await worker.call('dss_snapshot',{}),workerNote=workerPaths(task.taskId,'A','w1').notes
 await worker.call('dss_record',{snapshotId:workerView.snapshotId,path:workerNote,text:'worker facts',append:true});check(await read(workerNote),'worker facts')
 const blocked=role('Worker',{workerId:'w2'},{workerBusiness:{assertLive(){throw new Error('ended Worker')},async assert(){}}}),blockedView=await blocked.call('dss_snapshot',{})
 await rejects(()=>blocked.call('dss_record',{snapshotId:blockedView.snapshotId,path:workerPaths(task.taskId,'A','w2').notes,text:'bad',append:true}),/ended Worker/)
 check(await read(workerPaths(task.taskId,'A','w2').notes),undefined)
 const originalAppend=files.append.bind(files);let attempts=0
 files.append=async(p,text)=>{attempts++;await originalAppend(p,text.slice(0,2));throw new Error('controlled partial append')}
 await rejects(()=>planner.call('dss_record',{snapshotId:view.snapshotId,path:note,text:'ABCDEF',append:true}),/not confirmed.*Read the actual file/)
 check(attempts,1);check((await read(note)).endsWith('AB'),true);files.append=originalAppend
 // Different Worker files proceed while one append is deliberately held.
 let release,entered;const gate=new Promise(r=>release=r),start=new Promise(r=>entered=r)
 files.append=async(p,text)=>{if(p===note){entered();await gate}return originalAppend(p,text)}
 const pending=planner.call('dss_record',{snapshotId:view.snapshotId,path:note,text:'held',append:true});await start
 await worker.call('dss_record',{snapshotId:workerView.snapshotId,path:workerNote,text:' independent',append:true});check(await read(workerNote),'worker facts independent');release();await pending;files.append=originalAppend
 // Compound Helper notification uses its own accepted physical publication, not a generic transaction.
 const helper=role('Helper',{taskId:undefined}),helperView=await helper.call('dss_snapshot',{})
 await helper.call('dss_record',{snapshotId:helperView.snapshotId,path:'debug/2026-11-08.md',text:'plain debug',append:true});check(await read('debug/2026-11-08.md'),'plain debug')
 await helper.call('dss_record',{snapshotId:helperView.snapshotId,path:'debug/2026-11-08.md',text:'notify',append:true,notifyForeground:true})
 check(await read('debug/2026-11-08.md'),'plain debugnotify')
 const abort=new AbortController();abort.abort(new Error('cancelled'))
 await rejects(()=>planner.call('dss_record',{snapshotId:view.snapshotId,path:note,text:'no',append:true},abort.signal),/cancelled/)
 // Normal pending notification is returned by each original handoff tool,
 // not surfaced as a storage failure or an empty successful command. Here the
 // command-build port is controlled; actual handoff publication is covered by
 // its separate physical terminal/Worker integration tests, not this harness.
 const signalPath='state/A/'+task.taskId+'/Planner_pending';await files.replace(signalPath,'')
 let mutationBuilds=0,committedEffects=0
 const genericFiles=Object.fromEntries(['snapshot','read','readBytes','list','listDirectory','prefetch'].map(k=>[k,files[k].bind(files)]))
 const notifyServices={files:genericFiles,notifications:async snapshot=>await files.read(snapshot,signalPath)===undefined?[]:[signalPath],
  transact:async(_id,_request,_options,build)=>{mutationBuilds++;const snapshot=await files.snapshot();try{const changes=await build(snapshot);committedEffects+=changes.length;throw new Error('No pending handoff should reach commit')}finally{await snapshot.release()}},
  workerBusiness:{assertLive(){},async assert(){},async transfer(){throw new Error('Pending signal must not transfer ownership')},async committed(){throw new Error('Pending signal must not end ownership')}}}
 for(const [name,roleName,bindingExtra,input] of [
 ['dss_worker_relay','Worker',{workerId:'handoff-worker'},{successorId:'successor',contract:'next',reply:'result',records:[]}],
 ['dss_worker_deliver','Worker',{workerId:'handoff-worker'},{reply:'result',records:[]}],
 ['dss_direct_deliver','Worker',{taskId:undefined,direct:{inputPath:'direct/input.md',signalPath:'state/Worker_source',resultPath:'direct/result.md',recipientSignal:'state/Planner_result'}},{text:'result'}],
 ['dss_complete','Planner',{}, {acceptance:'accepted',resultPaths:[]}],
 ]){
 const pendingRole=role(roleName,bindingExtra,notifyServices),pendingView=await pendingRole.call('dss_snapshot',{})
 const result=await pendingRole.call(name,{snapshotId:pendingView.snapshotId,...input})
 check(result.notifications,[signalPath]);check(typeof result.continuation,'string');check(pendingRole.ended,0);check(await read(signalPath),'')
 }
 check(mutationBuilds,4);check(committedEffects,0);await files.delete(signalPath)
 // User deliverables remain original files. The real TaskWorkspaces adapter
 // validates them; publishing their references changes only this Task metadata.
 const workspaces=new TaskWorkspaces(files,path.join(root,'outputs'),'A','20000000-0000-4000-8000-000000000001')
 const location=await workspaces.ensure(task.taskId)
 await fs.writeFile(path.join(location.directory,'one.txt'),'First original')
 await fs.writeFile(path.join(location.directory,'two.txt'),'Second original')
 const workspaceService={instanceUUID:workspaces.instanceUUID,locate:(id,s)=>workspaces.locate(id,s),
  reference:(_agent,id,p,s)=>workspaces.reference(id,p,location.directory,s),validate:(r,s)=>workspaces.validate(r,s)}
 const producer=role('Planner',{}, {workspace:workspaceService}),producerView=await producer.call('dss_snapshot',{})
 const published=await Promise.all(['one.txt','two.txt'].map(sourcePath=>producer.call('dss_workspace_reference',{snapshotId:producerView.snapshotId,sourcePath})))
 let metadata=JSON.parse(await read(paths.task(task.taskId)))
 check(metadata.workspaceResults.length,2);check(metadata.status,'running');check(metadata.sourcePath,task.sourcePath)
 check(published.map(p=>p.nativePath).sort(),['one.txt','two.txt'].map(p=>path.join(location.directory,p)).sort())
 check(await fs.readFile(path.join(location.directory,'one.txt'),'utf8'),'First original')
 const observation=await files.snapshot(),beforeReference=(await files.listDirectory(observation,'tasks/',{paths:[paths.task(task.taskId)]}))[0].version;await observation.release()
 await producer.call('dss_workspace_reference',{snapshotId:producerView.snapshotId,sourcePath:'one.txt'})
 const after=await files.snapshot();check((await files.listDirectory(after,'tasks/',{paths:[paths.task(task.taskId)]}))[0].version,beforeReference);await after.release()
 metadata=JSON.parse(await read(paths.task(task.taskId)));check(metadata.workspaceResults.length,2)
 const deniedProducer=role('Worker',{workerId:'ended-workspace'}, {workspace:workspaceService,workerBusiness:{assertLive(){throw new Error('ended Worker')},async assert(){}}})
 const deniedView=await deniedProducer.call('dss_snapshot',{})
 await rejects(()=>deniedProducer.call('dss_workspace_reference',{snapshotId:deniedView.snapshotId,sourcePath:'one.txt'}),/ended Worker/)
 check(JSON.parse(await read(paths.task(task.taskId))).workspaceResults.length,2)
 await rejects(()=>producer.call('dss_workspace_reference',{snapshotId:producerView.snapshotId,sourcePath:'one.txt'},abort.signal),/cancelled/)
 // Host retires runtime Task metadata after actual whole-directory cleanup.
 // The real Host/Cleaner chain and both root/child late tools are exercised in
 // validate-physical-task-history; this port fixture uses that exact absence.
 await files.delete(paths.task(task.taskId))
 await files.delete(note)
 await rejects(()=>planner.call('dss_record',{snapshotId:view.snapshotId,path:note,text:'resurrect',append:true}),/records require their bound independent P Task/)
 check(await read(note),undefined)
 // Foreground's independent lasting memory is not tied to that task cleanup.
 const foregroundRoot='assistants/collaborations/local/test',foreground=role('Foreground',{taskId:undefined},{conversation:{foregroundRoot}})
 const foregroundView=await foreground.call('dss_snapshot',{})
 await foreground.call('dss_record',{snapshotId:foregroundView.snapshotId,path:foregroundRoot+'/Foreground_Cache.md',text:'Keep my memory',append:true})
 check(await read(foregroundRoot+'/Foreground_Cache.md'),'Keep my memory')
 // Original total-task submission publishes only the source, no early TaskID
 // or extra signal; the already wired Host initialization owns those later.
 await foreground.call('dss_submit_task',{snapshotId:foregroundView.snapshotId,name:'User requested task',route:'P',text:'Keep exact requirement\r\n'})
 check(await read('tasks/User requested task_P.md'),'Keep exact requirement\r\n')
 await rejects(()=>foreground.call('dss_submit_task',{snapshotId:foregroundView.snapshotId,name:'User requested task',route:'P',text:'overwrite'}),/filename already exists/)
 check(await read('tasks/User requested task_P.md'),'Keep exact requirement\r\n')
 await foreground.call('dss_submit_task',{snapshotId:foregroundView.snapshotId,name:'Package',route:'O',text:'Independent objectives'})
 check(await read('tasks/Package_O.md'),'Independent objectives')
 console.log(JSON.stringify({status:'passed',assertions,limits:'Actual physical record ports; explicit schemas/Markdown/skills stubs; no native DSH/Windows/full typecheck; compound Helper notification included; interrupted Helper report publication verified separately; Worker publication is verified separately; notification response uses explicit controlled command builder',sourceHashes:Object.fromEntries(loaded)},null,2))
}finally{await files.close();hooks.deregister();await fs.rm(root,{recursive:true,force:true})}
