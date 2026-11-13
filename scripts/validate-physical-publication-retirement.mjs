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
const {retirePhysicalPublicationsFromEvents}=await import('../src/framework/physical-publication-retirement.ts')
const {taskInitializationFiles}=await import('../src/framework/task-files.ts')
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'dss-publication-retirement-'))
const id='10000000-0000-4000-8000-000000000001',task={version:1,taskId:id,owner:'A',members:['A','B'],route:'O',status:'running',sourcePath:'tasks/root_O.md',archiveFolder:id}
let assertions=0
const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
const read=async(files,p)=>{const s=await files.snapshot();try{return await files.read(s,p)}finally{await s.release()}}
const requirementPath=(execution,call)=>paths.run(id)+'/.requirements/'+createHash('sha256').update(JSON.stringify(execution+':'+call)).digest('hex')
async function seed(files){await files.replace(paths.task(id),JSON.stringify(task));await files.replace(task.sourcePath,'Original requirement\r\n');for(const change of taskInitializationFiles(task))await files.replace(change.path,change.content)}
function role(files,roleName,flush){
 const callbacks=[],events=[],effects=[],errors=[],tools=new Map(),execution='actual-execution-'+roleName
 const agent={id:'native-id-is-not-execution',session:{snapshotEvents:()=>events}}
 const ctx={on:(_event,fn)=>{callbacks.push(fn);return()=>{}},effect:fn=>effects.push(fn()),sessions:{flush},systemPrompt:{section(){}},tools:{register:t=>tools.set(t.name,t)}}
 const binding={role:roleName,owner:'A',workId:roleName,executionId:execution,...(roleName==='Organizer'?{taskId:id}: {})}
 installFrameworkRoleTools(ctx,agent,binding,{files,transact:async()=>{throw Error('Unexpected generic transaction')},notifications:async()=>[],claimNotifications:async()=>({signals:[]}),onError:e=>errors.push(e)})
 async function call(name,input,callId=name,ack=false){const invocation={type:'tool/call',data:{name,callId,arguments:JSON.stringify(input),turn:1,step:1}};events.push(invocation)
  const result=await tools.get(name).execute(input,{agent,callId,signal:new AbortController().signal,concludeTurn(){}})
  if(ack){const success={type:'tool/result',data:{turn:1,message:{toolCallId:callId,isError:false}}};events.push(success);for(const fn of callbacks)fn(agent.session,success)}
  return result}
 return {events,execution,errors,call,async dispose(){for(const dispose of effects)await dispose()}}
}
try{
 // Without a persisted successful native result, completed publication facts
 // remain available for the original unknown-result retry window.
 let files=new PhysicalLocalFiles(path.join(scratch,'files'));await seed(files)
 let flushCount=0,flushRelease,flushEntered
 const gate=new Promise(r=>flushRelease=r),entered=new Promise(r=>flushEntered=r)
 const foreground=role(files,'Foreground',async()=>{flushCount++;flushEntered();await gate;await fs.writeFile(path.join(scratch,'foreground-events.json'),JSON.stringify(foreground.events))})
 const view=await foreground.call('dss_snapshot',{taskId:id}),args={snapshotId:view.snapshotId,text:'Actual accepted supplement\r\n'}
 await foreground.call('dss_supplement_task',args,'supplement',true);await entered
 const fact=requirementPath(foreground.execution,'supplement')+'/publication.json'
 check(!!await read(files,fact),true);check(flushCount,1)
 flushRelease();await foreground.dispose();check(await read(files,fact),undefined);check(existsSync(path.join(files.directory,requirementPath(foreground.execution,'supplement'))),false)
 check(await read(files,task.sourcePath),'Original requirement\r\n\n\nActual accepted supplement\r\n');check(await read(files,paths.state('A',id)+'/Organizer_Foreground'),'')
 // Exact failed native flush does not authorize deleting any recovery fact.
 const failed=role(files,'Foreground',async()=>{throw Error('flush not durable')})
 const next=await failed.call('dss_snapshot',{taskId:id}),nextArgs={snapshotId:next.snapshotId,text:'Second actual requirement'}
 await failed.call('dss_supplement_task',nextArgs,'failed-flush',true);await failed.dispose()
 const pending=requirementPath(failed.execution,'failed-flush')+'/publication.json';check(!!await read(files,pending),true);check(failed.errors.length,1)
 // On restart, original persisted call/result events are sufficient without
 // a directory scan or guessed equality between native Agent ID and execution.
 const persisted=JSON.parse(JSON.stringify(failed.events));await files.close();files=new PhysicalLocalFiles(path.join(scratch,'files'))
 const list=files.list.bind(files),listDirectory=files.listDirectory.bind(files);files.list=async()=>{throw Error('Retirement must not scan')};files.listDirectory=async()=>{throw Error('Retirement must not scan')}
 await retirePhysicalPublicationsFromEvents(files,failed.execution,persisted);check(await read(files,pending),undefined)
 files.list=list;files.listDirectory=listDirectory
 // A failed result, unmatched result, or wrong execution cannot retire a
 // completed original fact. The correct exact native success can.
 const organizer=role(files,'Organizer',async()=>{})
 const ov=await organizer.call('dss_snapshot',{}),dispatch={snapshotId:ov.snapshotId,objectiveId:'child',member:'B',route:'P',plan:'Child original\r\n',decision:'Dispatch fact\r\n'}
 await organizer.call('dss_planner_dispatch',dispatch,'dispatch')
 const df=requirementPath(organizer.execution,'dispatch')+'/publication.json'
 const call=organizer.events.find(x=>x.type==='tool/call'&&x.data.callId==='dispatch'),good={type:'tool/result',data:{message:{toolCallId:'dispatch',isError:false}}}
 await retirePhysicalPublicationsFromEvents(files,organizer.execution,[call,{type:'tool/result',data:{message:{toolCallId:'dispatch',isError:true}}}]);check(!!await read(files,df),true)
 await retirePhysicalPublicationsFromEvents(files,'another-execution',[call,good]);check(!!await read(files,df),true)
 await retirePhysicalPublicationsFromEvents(files,organizer.execution,[good]);check(!!await read(files,df),true)
 await retirePhysicalPublicationsFromEvents(files,organizer.execution,[call,good]);check(await read(files,df),undefined)
 const parent=JSON.parse(await read(files,paths.task(id))),child=JSON.parse(await read(files,paths.task(parent.children[0].taskId)))
 check(await read(files,child.sourcePath),'Task ID: '+child.taskId+'\nChild original\r\n');check(await read(files,paths.inbox(child.taskId,'B')),'Child original\r\n');check(await read(files,paths.state('B',child.taskId)+'/Planner_Inbox'),'')
 await organizer.dispose()
 // Simulate process loss after exact fact deletion but before empty-dir removal;
 // replay of native success finishes only those exact empty technical paths.
 const empty=requirementPath(organizer.execution,'dispatch');await fs.mkdir(path.join(files.directory,empty),{recursive:true})
 await retirePhysicalPublicationsFromEvents(files,organizer.execution,[call,good]);check(existsSync(path.join(files.directory,empty)),false)
 await files.close()
 console.log(JSON.stringify({status:'passed',assertions,limits:'Actual role-tools event callback and retirement functions with controlled native event/flush ports and persisted JSON event replay. Not real DSH native integration; no schema parsing/full tsc/Windows/power-loss claim.',sourceHashes:Object.fromEntries(loaded)},null,2))
}finally{await fs.rm(scratch,{recursive:true,force:true});hooks.deregister()}
