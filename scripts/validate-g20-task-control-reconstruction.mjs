import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import {sourceRoot,hash as sdkHash,hooks,evidence,loaded} from './test-support/dsh-sdk-runtime.mjs'
import {openDshStorageFixture} from './test-support/dsh-sdk-storage.mjs'
const supplemental=registerHooks({resolve(s,c,next){if(s==='mdast-util-from-markdown')return{url:'data:text/javascript,export function fromMarkdown(){throw new Error("Markdown outside recovery control test")}',shortCircuit:true};return next(s,c)}})
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
const {withSnapshot,withOperationChannel}=await import('../src/framework/transactions.ts')
const {GitAuthorityStore}=await import('../src/framework/git-authority.ts')
const {readTaskCleanupRecord}=await import('../src/framework/cleaner.ts')
const {createRecoveryWatch,dueRecoveryWatch}=await import('../src/framework/recovery.ts')
const source=readFileSync(new URL('framework/role-runtime.ts',sourceRoot),'utf8')
function method(name){const start=source.indexOf(name);assert(start>=0,name);const next=source.slice(start+name.length).search(/\n  (?:private |async |[A-Za-z]+\()/);assert(next>=0,name);return source.slice(start,start+name.length+next)}

const {reconstructPhysicalTask}=await import('../src/framework/physical-task-recovery.ts')
const taskFiles=await import('../src/framework/task-files.ts'),archive=await import('../src/framework/task-archive.ts'),workspacePaths=await import('../src/framework/workspace-paths.ts')
const {GitFiles}=await import('../src/framework/transactions.ts')
const names=['  private roleKey(', '  private async recoverMissingTask(', '  private rememberTerminalTask(', '  private startTaskControlDiscovery(', '  private retryStartupControls(', '  private startMaintenance(', '  async applyUserControls(', '  private async serialWork<']
const {ExecutionControls}=await import('../src/framework/execution-control.ts')
const {cancelPhysicalTask}=await import('../src/framework/physical-task-terminal.ts')
const {taskFamily}=await import('../src/framework/task-relations.ts')
const deps={taskFamily,withOperationChannel,annotateFailure:e=>e,...taskFiles,...archive,...workspacePaths,hash:t=>createHash('sha256').update(t).digest('hex'),SessionId:id=>id,
 PhysicalLocalFiles,GitAuthorityStore,GitFiles,withSnapshot,reconstructPhysicalTask,isAbsolute:path.isAbsolute,join:path.join,resolve:path.resolve}
const Runtime=new Function(...Object.keys(deps),stripTypeScriptTypes('class Runtime {\n'+names.map(method).join('\n')+'\n}',{mode:'transform'})+'\nreturn Runtime')(...Object.values(deps))
const runtime=new Runtime(),sdk=await openDshStorageFixture(path.join(root,'sdk'),path.join(root,'locator')),records=sdk.adapter
const controls=new ExecutionControls(records,'reconstruct-control',undefined,files,records,'recovery-host'),errors=[]
const tick=()=>new Promise(setImmediate)
async function drain(){const deadline=performance.now()+5000;for(;;){const ops=[...runtime.maintenance?.values()??[]];if(!ops.length)return;if(performance.now()>=deadline)throw Error('Recovery control discovery did not drain');await Promise.allSettled(ops);await new Promise(resolve=>setTimeout(resolve,1))}}
const hash=deps.hash,retained=paths.member(task.taskId,'A')+'/Planner_Memory.md',signal=paths.state('A',task.taskId)+'/recovery'
let interruptedOperations=0
try{
 const workspaces=new TaskWorkspaces(files,path.join(root,'outputs'),'A','20000000-0000-4000-8000-000000000001')
 const location=await workspaces.ensure(task.taskId),nativeFile=path.join(location.directory,'original.bin')
 await fs.writeFile(nativeFile,Buffer.from([0,255,10,7]));await files.replace(retained,'Original retained Memory, not a new instruction.')
 const identity={workId:'original-planner',executionId:'original-execution',role:'Planner',taskId:task.taskId,member:'A'}
 const roleRecord={identity,sessionId:'original-session',generation:1,stopped:true,taskWorkspace:location}
 const prefix='framework-runtime/'+hash('reconstruct-control')+'/',roleKey=prefix+'roles/'+hash(identity.workId);await records.set(roleKey,roleRecord)
 Object.assign(runtime,{files,records,prefix,config:{member:'A',workspace:workspaces.root},workspaces,closed:false,roleRecords:new Map([[identity.workId,roleRecord]]),
 knownTaskLifecycles:new Map(),observedTerminalTasks:new Map(),pendingTaskControlDiscovery:new Map(),pendingControlStops:[],stopOperations:new Map(),startupControlsDiscovered:true,controls,currentTask:async r=>r.identity.taskId,environment:{},error:e=>errors.push(String(e)),loop:{hasTerminalTask:()=>false},archiveHostKey:()=> 'A',trackedStop:()=>true,
 ctx:{sessions:{get:()=>({header:{cwd:location.directory}})},get:()=>undefined},transactions:{run(){throw Error('Generic task-recovery transaction reached')}},
 updateSafetyRestoreRow:async(_key,_id,update)=>{const changed=update(currentRow.value);Object.assign(currentRow.value,changed);return changed},
 saveRole:async value=>{runtime.roleRecords.set(value.identity.workId,value);await records.set(roleKey,value)}})
 const currentRow={key:'restore/actual',value:{commandId:'actual-reconstruct',createdAt:'2026-11-08T00:00:00Z',complete:false,input:{target:identity,taskRecovery:{route:'P',owner:'A',recordPaths:[retained],continuation:'Continue from these exact original records.'}}}}
 const oldStop={...identity,executionId:'original-unfinished-prior-execution'}
 await controls.requestExecutionStop('old-exact-stop',oldStop)
 // Existing running Task fills only missing support and preserves current Note.
 check(await runtime.recoverMissingTask(currentRow),true)
 await drain();check(runtime.pendingTaskControlDiscovery.size,0);check((await controls.execution(oldStop)).result.state,'superseded');check(errors,[])
 check(await read(retained),'Original retained Memory, not a new instruction.');check((await read(paths.inbox(task.taskId,'A'))).includes('Continue from these exact original records.'),true)
 check(JSON.parse(await read(paths.task(task.taskId))).workspaceFolder,location.folder)
 check([...await fs.readFile(nativeFile)],[0,255,10,7])
 // Reopening terminal history retains originals first and restores the same ID.
 await cancelPhysicalTask(files,{taskId:task.taskId},'A','cancel-before-real-reconstruction')
 const completed=JSON.parse(await read(paths.task(task.taskId)));check(completed.status,'cancelled');await files.replace(signal,'')
 const binaryPath=paths.run(task.taskId)+'/binary/original.bin',binary=Buffer.alloc(2*1024*1024,37);binary[8]=255
 await files.replace(binaryPath,binary);const oldSource=await read(task.sourcePath),oldNote=await read(retained)
 const secondOld={...identity,executionId:'second-unfinished-old-life'};await controls.requestExecutionStop('second-old-stop',secondOld)
 currentRow.value.commandId='reopen-original';currentRow.value.input={...currentRow.value.input,facts:'Actual terminal continuation authorization'}
 check(await runtime.recoverMissingTask(currentRow),true)
 await drain();check(runtime.pendingTaskControlDiscovery.size,0);check((await controls.execution(secondOld)).result.state,'superseded');check(errors,[])
 const reconstructed=JSON.parse(await read(paths.task(task.taskId))),history=paths.archive(completed)+'/lifecycles/original/'+hash(currentRow.value.commandId).slice(0,24)
 check(reconstructed.taskId,task.taskId);check(reconstructed.status,'running');check(reconstructed.lifecycleId,hash('restore-task:'+currentRow.value.commandId).slice(0,24))
 check(await read(history+'/files/'+retained),oldNote);check(await read(history+'/files/'+task.sourcePath),oldSource)
 check(await withSnapshot(files,s=>files.readBytes(s,history+'/files/'+binaryPath)),binary)
 check(JSON.parse(await read(history+'/recovery.json')).input,currentRow.value.input)
 check(await read(signal),undefined);check(await read(retained),oldNote);check([...await fs.readFile(nativeFile)],[0,255,10,7])
 await files.replace(retained,'Later real Memory');await files.replace(signal,'')
 check(await runtime.recoverMissingTask(currentRow),true);check(await read(retained),'Later real Memory');check(await read(signal),'')

 check((await controls.task(task.taskId,reconstructed.lifecycleId)),undefined)
 check((await controls.execution(secondOld)).lifecycleId,undefined)
 console.log(JSON.stringify({status:'passed',assertions,errors,...evidence(),limits:'Actual recoverMissingTask, rememberTerminalTask, startTaskControlDiscovery, retryStartupControls, applyUserControls and maintenance bodies; real DSH SDK records and physical reconstruction. Original retained RoleRecord is confirmed-stopped fixture input; trackedStop and native session workspace lookup are controlled ports. No live model or whole native teardown. Terminal status is produced by actual cancelPhysicalTask, not direct metadata editing. Old lifecycle pending requests are exact-read and superseded without applying to the new lifecycle; no prefix discovery in this path.'},null,2))
}finally{await files.close();await sdk.close();await fs.rm(root,{recursive:true,force:true});supplemental.deregister();hooks.deregister()}
