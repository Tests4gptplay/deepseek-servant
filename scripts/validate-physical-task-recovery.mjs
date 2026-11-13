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
const { paths,readJson,encodeJson,assertTaskLifecycle,taskLifecycleKey,readMemberStatus }=await import('../src/framework/task-files.ts')
const { TaskWorkspaces }=await import('../src/framework/task-workspace.ts')
let assertions=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++};const rejects=async(f,re)=>{await assert.rejects(f,re);assertions++}
const root=await fs.mkdtemp(path.join(os.tmpdir(),'dss-role-records-')),files=new PhysicalLocalFiles(root)
const read=async p=>{const s=await files.snapshot();try{return await files.read(s,p)}finally{await s.release()}}
const task={version:1,taskId:'10000000-0000-4000-8000-000000000001',route:'P',owner:'A',members:['A'],status:'running',sourcePath:'tasks/a.md'}
await files.replace(paths.task(task.taskId),JSON.stringify(task));await files.replace(task.sourcePath,'Original requirement')
let calls=0
function role(roleName,extra={},services={}){
 const tools=new Map(),agent={id:'agent-'+roleName,session:{}},ctx={on:()=>()=>{},effect:()=>{},systemPrompt:{section(){}},tools:{register:t=>tools.set(t.name,t)}}
 const binding={role:roleName,taskId:task.taskId,owner:'A',member:'A',workId:'work-'+roleName,executionId:'execution-'+roleName,...extra}
 installFrameworkRoleTools(ctx,agent,binding,{files,transact:async()=>{throw new Error('Unexpected generic transaction')},notifications:async()=>[],claimNotifications:async()=>({signals:[]}),onError:()=>{},...services})
 let ended=0
 return {get ended(){return ended},call:(name,input,signal=new AbortController().signal)=>tools.get(name).execute(input,{agent,callId:'call-'+(++calls),signal,concludeTurn:()=>ended++}),binding}
}
const {publishPhysicalRecovery,consumePhysicalRecovery}=await import('../src/framework/physical-recovery.ts')
const {withSnapshot}=await import('../src/framework/transactions.ts')
const {GitAuthorityStore}=await import('../src/framework/git-authority.ts')
const {readTaskCleanupRecord}=await import('../src/framework/cleaner.ts')
const {createRecoveryWatch,dueRecoveryWatch}=await import('../src/framework/recovery.ts')
const source=readFileSync(new URL('framework/role-runtime.ts',sourceRoot),'utf8')
function method(name){const start=source.indexOf(name);assert(start>=0,name);const next=source.slice(start+name.length).search(/\n  (?:private |async |[A-Za-z]+\()/);assert(next>=0,name);return source.slice(start,start+name.length+next)}

const {reconstructPhysicalTask}=await import('../src/framework/physical-task-recovery.ts')
const taskFiles=await import('../src/framework/task-files.ts'),archive=await import('../src/framework/task-archive.ts'),workspacePaths=await import('../src/framework/workspace-paths.ts')
const {GitFiles}=await import('../src/framework/transactions.ts')
const names=['  private async recoverMissingTask(', '  private rememberTerminalTask(']
const deps={...taskFiles,...archive,...workspacePaths,hash:t=>createHash('sha256').update(t).digest('hex'),SessionId:id=>id,
 PhysicalLocalFiles,GitAuthorityStore,GitFiles,withSnapshot,reconstructPhysicalTask,isAbsolute:path.isAbsolute,join:path.join,resolve:path.resolve}
const Runtime=new Function(...Object.keys(deps),stripTypeScriptTypes('class Runtime {\n'+names.map(method).join('\n')+'\n}',{mode:'transform'})+'\nreturn Runtime')(...Object.values(deps))
const runtime=new Runtime(),values=new Map(),records={async get(k){return structuredClone(values.get(k))},async set(k,v){values.set(k,structuredClone(v))}}
const hash=deps.hash,retained=paths.member(task.taskId,'A')+'/Planner_Memory.md',signal=paths.state('A',task.taskId)+'/recovery'
let interruptedOperations=0
try{
 const workspaces=new TaskWorkspaces(files,path.join(root,'outputs'),'A','20000000-0000-4000-8000-000000000001')
 const location=await workspaces.ensure(task.taskId),nativeFile=path.join(location.directory,'original.bin')
 await fs.writeFile(nativeFile,Buffer.from([0,255,10,7]));await files.replace(retained,'Original retained Memory, not a new instruction.')
 const identity={workId:'original-planner',executionId:'original-execution',role:'Planner',taskId:task.taskId,member:'A'}
 const roleRecord={identity,sessionId:'original-session',generation:1,stopped:true,taskWorkspace:location}
 const roleKey='runtime/roles/'+hash(identity.workId);await records.set(roleKey,roleRecord)
 Object.assign(runtime,{files,records,prefix:'runtime/',config:{member:'A',workspace:workspaces.root},workspaces,closed:false,roleRecords:new Map([[identity.workId,roleRecord]]),
 knownTaskLifecycles:new Map(),observedTerminalTasks:new Map(),pendingTaskControlDiscovery:new Map(),startTaskControlDiscovery(){},loop:{hasTerminalTask:()=>false},archiveHostKey:()=> 'A',trackedStop:()=>true,serialWork:async(_id,fn)=>fn(),
 ctx:{sessions:{get:()=>({header:{cwd:location.directory}})},get:()=>undefined},transactions:{run(){throw Error('Generic task-recovery transaction reached')}},
 updateSafetyRestoreRow:async(_key,_id,update)=>{const changed=update(currentRow.value);Object.assign(currentRow.value,changed);return changed},
 saveRole:async value=>{runtime.roleRecords.set(value.identity.workId,value);await records.set(roleKey,value)}})
 const currentRow={key:'restore/actual',value:{commandId:'actual-reconstruct',createdAt:'2026-11-08T00:00:00Z',complete:false,input:{target:identity,taskRecovery:{route:'P',owner:'A',recordPaths:[retained],continuation:'Continue from these exact original records.'}}}}
 // Existing running Task fills only missing support and preserves current Note.
 check(await runtime.recoverMissingTask(currentRow),true)
 check(await read(retained),'Original retained Memory, not a new instruction.');check((await read(paths.inbox(task.taskId,'A'))).includes('Continue from these exact original records.'),true)
 check(JSON.parse(await read(paths.task(task.taskId))).workspaceFolder,location.folder)
 check([...await fs.readFile(nativeFile)],[0,255,10,7])
 // A completed Task stays closed; subsequent corrections require a new Task ID.
 const completed={...JSON.parse(await read(paths.task(task.taskId))),status:'complete'}
 await files.replace(paths.task(task.taskId),JSON.stringify(completed));await files.replace(signal,'')
 const binaryPath=paths.run(task.taskId)+'/binary/original.bin',binary=Buffer.alloc(2*1024*1024,37);binary[8]=255
 await files.replace(binaryPath,binary);const oldSource=await read(task.sourcePath),oldNote=await read(retained)
 currentRow.value.commandId='completed-original';currentRow.value.input={...currentRow.value.input,facts:'A new correction was requested after completion'}
 await rejects(()=>runtime.recoverMissingTask(currentRow),/completed Task cannot resume the same Task ID/)
 check(JSON.parse(await read(paths.task(task.taskId))),completed);check(await read(signal),'');check(await read(retained),oldNote)
 // Explicitly cancelled work remains a separate, user-selected recovery case.
 await files.replace(paths.task(task.taskId),JSON.stringify({...completed,status:'cancelled'}))
 currentRow.value.commandId='reopen-cancelled';currentRow.value.input={...currentRow.value.input,facts:'User explicitly requested recovery of the cancelled original work'}
 check(await runtime.recoverMissingTask(currentRow),true)
 const reconstructed=JSON.parse(await read(paths.task(task.taskId))),history=paths.archive(completed)+'/lifecycles/original/'+hash(currentRow.value.commandId).slice(0,24)
 check(reconstructed.taskId,task.taskId);check(reconstructed.status,'running');check(reconstructed.lifecycleId,hash('restore-task:'+currentRow.value.commandId).slice(0,24))
 check(await read(history+'/files/'+retained),oldNote);check(await read(history+'/files/'+task.sourcePath),oldSource)
 check(await withSnapshot(files,s=>files.readBytes(s,history+'/files/'+binaryPath)),binary)
 check(JSON.parse(await read(history+'/recovery.json')).input,currentRow.value.input)
 check(await read(signal),undefined);check(await read(retained),oldNote);check([...await fs.readFile(nativeFile)],[0,255,10,7])
 await files.replace(retained,'Later real Memory');await files.replace(signal,'')
 check(await runtime.recoverMissingTask(currentRow),true);check(await read(retained),'Later real Memory');check(await read(signal),'')

 const planTask={...task,sourcePath:'tasks/reconstructed.md',lifecycleId:'new-life'}
 const old='task-runs/'+task.taskId+'/original.bin',target='archives/recovery-history/original.bin',oldNotice='state/A/'+task.taskId+'/old'
 async function fixture(name){const f=new PhysicalLocalFiles(path.join(root,name));await f.replace(old,Buffer.from([0,255,12]));await f.replace(oldNotice,'');await f.replace(paths.task(task.taskId),JSON.stringify({...task,status:'complete'}));return f}
 const plan=async f=>({task:planTask,source:{path:planTask.sourcePath,text:'Original accepted recovery input'},inbox:{path:paths.inbox(task.taskId,'A'),text:'original continuation'},memberStatus:{path:paths.memberStatus(task.taskId,'A'),text:'{"state":"running"}'},cache:{path:paths.cache(task.taskId),text:'{"version":1,"links":[]}'},history:{path:'archives/recovery-history',execution:'original execution',recovery:'original recovery evidence',copies:[{source:old,target}],signals:[{path:oldNotice,version:(await f.fileInfo(oldNotice)).version}]}})
 let f=await fixture('trace'),trace=[]
 for(const method of ['replace','stageCopy','rename','deleteObserved']){const actual=f[method].bind(f);f[method]=async(...args)=>{trace.push([method,...args]);return actual(...args)}}
 const expected=await plan(f),input={target:identity,continuation:'accepted once'}
 await reconstructPhysicalTask(f,task.taskId,'same-command',input,async()=>expected,()=>{});await f.close()
 for(const when of ['before','after'])for(let stop=0;stop<trace.length;stop++){
  f=await fixture(when+'-'+stop);const expected=await plan(f);let step=0,hit=false
  for(const method of ['replace','stageCopy','rename','deleteObserved']){const actual=f[method].bind(f);f[method]=async(...args)=>{const ordinal=step++;if(ordinal===stop&&when==='before'){hit=true;throw Error('actual interruption')}const result=await actual(...args);if(ordinal===stop&&when==='after'){hit=true;throw Error('actual interruption')}return result}}
  await rejects(()=>reconstructPhysicalTask(f,task.taskId,'same-command',input,async()=>expected,()=>{}),/actual interruption/);check(hit,true);interruptedOperations++
  const directory=f.directory;await f.close();f=new PhysicalLocalFiles(directory)
  await reconstructPhysicalTask(f,task.taskId,'same-command',input,async()=>expected,()=>{})
  const at=p=>withSnapshot(f,s=>f.read(s,p))
  check(JSON.parse(await at(paths.task(task.taskId))),planTask);check(await at(planTask.sourcePath),'Original accepted recovery input')
  check(await withSnapshot(f,s=>f.readBytes(s,target)),Buffer.from([0,255,12]));check(await at(oldNotice),undefined)
  await f.replace(planTask.sourcePath,'Later input edit');await f.replace(oldNotice,'')
  await reconstructPhysicalTask(f,task.taskId,'same-command',input,async()=>{throw Error('No new plan on successful retry')},()=>{})
  check(await at(planTask.sourcePath),'Later input edit');check(await at(oldNotice),'');await f.close()
 }
 console.log(JSON.stringify({status:'passed',assertions,interruptedOperations,limits:'Actual recoverMissingTask production body, physical reconstruction publication and TaskWorkspaces validation, cold reconstruction at addressed file-operation failures. Controlled stopped-execution/session/technical-record ports. Not full typecheck, native DSH, Windows, OS power-loss or cutover acceptance.',sourceHashes:{...Object.fromEntries(loaded),'framework/role-runtime.ts':createHash('sha256').update(source).digest('hex')}},null,2))
}finally{await files.close();await fs.rm(root,{recursive:true,force:true});hooks.deregister()}
