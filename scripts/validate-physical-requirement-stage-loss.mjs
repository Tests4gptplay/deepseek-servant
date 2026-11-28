import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
// Actual Foreground supplement / Organizer dispatch installation and physical files. Schema parsing
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
const {spawnSync}=await import('node:child_process')
const {FrameworkHostLoop}=await import('../src/framework/host-loop.ts')
const {FrameworkTransactions}=await import('../src/framework/command-transactions.ts')
const {taskInitializationFiles}=await import('../src/framework/task-files.ts')
const {resumePhysicalTaskRequirement}=await import('../src/framework/physical-task-dispatch.ts')
const {cancelPhysicalTask}=await import('../src/framework/physical-task-terminal.ts')
const ids=[1,2,3].map(n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0'))
const task=(route='P',id=ids[0])=>({version:1,taskId:id,route,owner:'A',members:['A','B'],status:'running',sourcePath:'tasks/'+id+'_'+route+'.md',archiveFolder:id})
const original='原始要求\r\nKeep original bytes.\r\n',supplement='新增要求\r\nNo invented facts.',plan='实际目标\r\nIndependent requirement.',decision='Organizer original decision\r\n'
let assertions=0,processInterruptions=0,interruptedOperations=0,hostInterleavings=0
const faultCases={},processExitPhases=[],hostInterleavingPhases=[]
const check=(a,b)=>{assert.deepEqual(a,b);assertions++},rejects=async(f,re)=>{await assert.rejects(f,re);assertions++}
const read=async(files,p)=>{const s=await files.snapshot();try{return await files.read(s,p)}finally{await s.release()}}
const metadata=async(files,t)=>JSON.parse(await read(files,paths.task(t.taskId)))
async function seed(files,t){await files.replace(paths.task(t.taskId),JSON.stringify(t));await files.replace(t.sourcePath,'Task ID: '+t.taskId+'\n'+original);for(const change of taskInitializationFiles(t))await files.replace(change.path,change.content);if(t.route==='O')await files.replace(paths.run(t.taskId)+'/Dispatch.md','Existing decision\n')}
// Controlled recipient persistence boundary. Values are actual file
// observations and are saved before production deleteObserved, never invented
// from a missing stage. Full native receiver/runtime integration is separate.
async function acceptedSources(files){try{return JSON.parse(await fs.readFile(path.join(files.directory,'.test-receiver-sources.json'),'utf8'))}catch(e){if(e.code==='ENOENT')return [];throw e}}
async function consumePublished(files,target){const info=await files.fileInfo(target);assert(info);const sources=await acceptedSources(files);await fs.writeFile(path.join(files.directory,'.test-receiver-sources.json'),JSON.stringify([...sources,{path:target,version:info.version}]));await files.deleteObserved(target,info.version)}
function role(files,t,roleName,extra={}){
 const tools=new Map(),agent={id:roleName+'-agent',session:{}},ctx={on:()=>()=>{},effect:()=>{},systemPrompt:{section(){}},tools:{register:t=>tools.set(t.name,t)}}
 const binding={role:roleName,owner:t.owner,...(roleName==='Foreground'?{}:{taskId:t.taskId,lifecycleId:t.lifecycleId,member:t.owner}),workId:'work-'+roleName,executionId:'exec-'+roleName}
 installFrameworkRoleTools(ctx,agent,binding,{files,physicalSignalSources:()=>acceptedSources(files),transact:async()=>{throw new Error('Unexpected generic transaction')},notifications:async snapshot=>(await files.listDirectory(snapshot,paths.state(t.owner,t.taskId))).filter(row=>row.path.split('/').at(-1).startsWith(roleName+'_')).map(row=>row.path),claimNotifications:async()=>({signals:[]}),onError:()=>{},...extra})
 return (name,input,id=name)=>tools.get(name).execute(input,{agent,callId:id,signal:new AbortController().signal,concludeTurn(){}})
}
async function append(files,t,command='supplement',text=supplement){const call=role(files,t,'Foreground'),view=await call('dss_snapshot',{taskId:t.taskId});return call('dss_supplement_task',{snapshotId:view.snapshotId,text},command)}
async function dispatch(files,t,routeName='P',command='dispatch',objectiveId='objective',extra={}){const call=role(files,t,'Organizer'),view=await call('dss_snapshot',{});return call('dss_planner_dispatch',{snapshotId:view.snapshotId,objectiveId,member:'B',route:routeName,plan,decision,...extra},command)}
async function complete(files,t){const call=role(files,t,t.route==='O'?'Organizer':'Planner'),view=await call('dss_snapshot',{});return call('dss_complete',{snapshotId:view.snapshotId,acceptance:'Final acceptance\n',resultPaths:[]},'complete')}
function host(files,member='A',primary=true){
 const state=new Map(),errors=[],wakes=[],observed=[],storage={get:async k=>state.get(k),set:async(k,v)=>state.set(k,structuredClone(v))}
 const scope='dispatch-test-'+member,loop=new FrameworkHostLoop(files,new FrameworkTransactions(files,storage,scope),storage,{member,primary,scope,instanceUUID:ids[2]},()=>['A','B'],{
 startup:async()=>{},observe:async()=>{},physicalSignalSources:()=>acceptedSources(files),wake:async request=>{wakes.push(request);return false},executing:()=>false,sealBusiness:async()=>{},clean:async()=>false,
 releaseTask:async()=>{},initializeWorkspace:async()=>{},taskStateObserved:async t=>observed.push(t),error:e=>errors.push(e)})
 return {loop,errors,wakes,observed,async start(){await loop.start();await loop.firstPoll},async close(){await loop.stop()}}
}
async function hostResume(files,t){const h=host(files,t.owner);const s=await files.snapshot();try{await h.loop.scanTask(t,s,performance.now())}finally{await s.release();await h.close()}if(h.errors.length)throw new AggregateError(h.errors,'Host scan failed');return h.wakes}
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'dss-requirement-stage-loss-')),results=[]
try{
 for(const stageKind of ['source','inbox','decision','new-child-source','new-child-existing']){
  const f=new PhysicalLocalFiles(path.join(scratch,stageKind)),t=task(stageKind==='source'?'P':'O');await seed(f,t)
  let target=t.sourcePath
  if(stageKind==='inbox'||stageKind==='decision'){await dispatch(f,t,'P','initial');const parent=await metadata(f,t),child=JSON.parse(await read(f,paths.task(parent.children[0].taskId)));await f.delete(paths.state(child.owner,child.taskId)+'/Planner_Inbox');target=stageKind==='inbox'?paths.inbox(child.taskId,child.owner):paths.run(t.taskId)+'/Dispatch.md'}
  let before=await read(f,target);const replace=f.replace.bind(f);let publication,removed=false
  f.replace=async(p,c)=>{await replace(p,c);if(!removed&&p.endsWith('/publication.json')){const fact=JSON.parse(c),field=stageKind.startsWith('new-child')?'source':stageKind;if(fact.commandId.endsWith(':lost-stage')&&fact[field+'Prepared']&&!fact[field+'Published']){publication=p;removed=true;const stage=path.join(f.directory,path.posix.dirname(p),field+'.stage');if(stageKind.startsWith('new-child')){target=fact.child.sourcePath;before=stageKind==='new-child-existing'?'用户创建的实际内容\r\n':await fs.readFile(stage,'utf8');await fs.writeFile(path.join(f.directory,target),before)}if(stageKind!=='new-child-existing')await fs.rm(stage,{force:true});throw Error('Actual preparation interrupted after acceptance')}}}
  const run=()=>stageKind==='source'?append(f,t,'lost-stage'):dispatch(f,t,'P','lost-stage','objective',{plan:'New actual requirement',decision:'New actual Organizer decision'})
  await rejects(run,/preparation interrupted after acceptance/);f.replace=replace
  let error;try{await run()}catch(e){error=e.message}
  let hostError;try{await hostResume(f,await metadata(f,t))}catch(e){hostError=String(e)}
  const after=await read(f,target),fact=JSON.parse(await read(f,publication)),recipient=fact.child??fact.task,notice=paths.state(recipient.owner,recipient.taskId)+(stageKind==='source'?'/Planner_Foreground':'/Planner_Inbox')
  if(stageKind==='new-child-existing')check(await read(f,path.posix.dirname(publication)+'/source.stage'),'Task ID: '+fact.child.taskId+'\nNew actual requirement')
  results.push({stageKind,retryError:error??null,hostRecoveryRejected:!!hostError,targetStillOld:after===before,signalPresent:await read(f,notice)!==undefined,acceptedInputPreserved:await read(f,path.posix.dirname(publication)+'/'+(stageKind==='decision'?'decision.txt':'input.txt'))!==undefined})
  await f.close()
 }
 const passed=results.every(r=>r.retryError&&r.hostRecoveryRejected&&r.targetStillOld&&!r.signalPresent&&r.acceptedInputPreserved)
 console.log(JSON.stringify({status:passed?'passed':'failed',results,limits:'Actual installed Foreground supplement / Organizer existing-child and new-child ports plus real Host scanTask recovery. Remove the exact prepared source/Inbox/decision stage, replace the new child destination with identical bytes from another physical file, or retain the stage while the user creates destination content; retry the identical command and cold Host recovery. Native recipient, schema and unrelated Markdown/skill dependencies are controlled.',sourceHashes:Object.fromEntries(loaded)},null,2));if(!passed)process.exitCode=1
}finally{await fs.rm(scratch,{recursive:true,force:true});hooks.deregister()}
