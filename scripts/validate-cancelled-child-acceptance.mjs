import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { evidence } from './test-support/dsh-sdk-runtime.mjs'
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')
const { paths, taskInitializationFiles } = await import('../src/framework/task-files.ts')
const { cancelTask } = await import('../src/framework/task-cancellation.ts')
const { frameworkRolePrompt } = await import('../src/framework/role-prompts.ts')
const root=await fs.mkdtemp(path.join(os.tmpdir(),'dss-cancelled-child-'))
const files=new PhysicalLocalFiles(root)
const original='Original independent objective', plan='Actual child objective', decision='Actual dispatch decision'
const parent={version:1,taskId:'10000000-0000-4000-8000-000000000001',route:'O',owner:'A',members:['A','B'],status:'running',sourcePath:'tasks/10000000-0000-4000-8000-000000000001_O.md',archiveFolder:'10000000-0000-4000-8000-000000000001'}
const sources=[]
const read=async p=>{const view=await files.snapshot();try{return await files.read(view,p)}finally{await view.release()}}
const task=async id=>JSON.parse(await read(paths.task(id)))
async function consume(p){const info=await files.fileInfo(p);assert.ok(info,'expected actual signal '+p);sources.push({path:p,version:info.version});await files.deleteObserved(p,info.version)}
function role(t,name){
 const registered=new Map(),agent={id:name+'-agent',session:{}},ctx={on:()=>()=>{},effect:()=>{},systemPrompt:{section(){}},tools:{register:value=>registered.set(value.name,value)}}
 const binding={role:name,owner:t.owner,taskId:t.taskId,lifecycleId:t.lifecycleId,member:t.owner,workId:'test-'+name+'-'+t.taskId,executionId:'execution-'+name+'-'+t.taskId}
 installFrameworkRoleTools(ctx,agent,binding,{files,physicalSignalSources:async()=>sources,transact:async()=>{throw new Error('Unexpected generic transaction in physical fixture')},notifications:async snapshot=>(await files.listDirectory(snapshot,paths.state(t.owner,t.taskId))).filter(row=>row.path.split('/').at(-1).startsWith(name+'_')).map(row=>row.path),claimNotifications:async()=>({signals:[]}),onError:()=>{}})
 return (tool,input,id=tool)=>registered.get(tool).execute(input,{agent,callId:id,signal:new AbortController().signal,concludeTurn(){}})
}
async function dispatch(objectiveId){const call=role(parent,'Organizer'),view=await call('dss_snapshot',{});return call('dss_planner_dispatch',{snapshotId:view.snapshotId,objectiveId,member:'B',route:'P',plan,decision},'dispatch-'+objectiveId)}
async function complete(t,acceptance){const call=role(t,t.route==='O'?'Organizer':'Planner'),view=await call('dss_snapshot',{});return call('dss_complete',{snapshotId:view.snapshotId,acceptance,resultPaths:[]},'complete-'+t.taskId)}
try {
 await files.replace(paths.task(parent.taskId),JSON.stringify(parent));await files.replace(parent.sourcePath,'Task ID: '+parent.taskId+'\n'+original)
 for(const change of taskInitializationFiles(parent))await files.replace(change.path,change.content)
 await files.replace(paths.run(parent.taskId)+'/Dispatch.md','Existing decision\n')
 await dispatch('withdrawn');let links=(await task(parent.taskId)).children;const cancelled=await task(links[0].taskId)
 const result=await cancelTask({files,member:'B',physicalSignalSources:async()=>sources,transact:async()=>{throw new Error('Unexpected generic transaction in physical fixture')}},{taskId:cancelled.taskId},'user-cancel')
 assert.deepEqual(result.cancelledTaskIds,[cancelled.taskId]);assert.equal((await task(cancelled.taskId)).status,'cancelled');assert.deepEqual((await task(parent.taskId)).children,links)
 const view=await files.snapshot();let notice;try{notice=(await files.listDirectory(view,paths.state('A',parent.taskId))).find(x=>x.path.includes('Organizer_ChildCancelled_'))}finally{await view.release()}
 assert.ok(notice);await consume(notice.path)
 await dispatch('active');links=(await task(parent.taskId)).children;const active=await task(links.find(x=>x.objectiveId==='active').taskId)
 assert.equal(await read(paths.state(parent.owner,parent.taskId)+'/Recorder'),undefined)
 await assert.rejects(()=>complete(parent,'Acceptance while active child is running.'),/assigned child objective/);assert.equal((await task(parent.taskId)).status,'running')
 await consume(paths.state('B',active.taskId)+'/Planner_Inbox');await complete(active,'The active child objective was completed and evaluated.')
 assert.equal((await task(active.taskId)).status,'complete')
 await consume(paths.state('A',parent.taskId)+'/Organizer_Child_'+active.taskId)
 const acceptance='The active objective was accepted. The user-withdrawn child remains cancelled and is not represented as completed.'
 await complete(parent,acceptance)
 assert.equal((await task(parent.taskId)).status,'complete');assert.equal((await task(cancelled.taskId)).status,'cancelled')
 assert.equal(await read(cancelled.sourcePath),'Task ID: '+cancelled.taskId+'\n'+plan)
 assert.ok((await read(paths.run(parent.taskId)+'/Organizer_Note.md')).includes(acceptance))
 assert.equal(await read(paths.state(cancelled.owner,cancelled.taskId)+'/Recorder'),undefined)
 assert.equal(await read(paths.state(parent.owner,parent.taskId)+'/Recorder'),'')
 const prompt=frameworkRolePrompt('Organizer')
 assert.ok(prompt.includes('A cancelled child is not a completed objective or a success.'))
 assert.ok(prompt.includes('determine whether its objective was withdrawn or still needs work'))
 assert.ok(!prompt.includes('A cancelled or failed child is not a completed objective: report its actual status and keep overall acceptance incomplete'))
 console.log(JSON.stringify({status:'passed',scope:'Actual Zod parsing, registered DSS tools, PhysicalLocalFiles and production cancelTask. Native Agent and signal receiver are controlled ports; no GUI, Windows, online Git or real model.',evidence:evidence()},null,2))
}finally{await files.close();await fs.rm(root,{recursive:true,force:true})}
