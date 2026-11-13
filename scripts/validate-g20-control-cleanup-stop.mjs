import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {createRequire} from 'node:module'
import {pathToFileURL,fileURLToPath} from 'node:url'
const base=path.resolve(process.env.DSS_LEGACY_TEST_SOURCE ?? fileURLToPath(new URL('../',import.meta.url)))+'/'
const {hooks,evidence}=await import(base+'scripts/test-support/dsh-sdk-runtime.mjs')
const {openDshStorageFixture}=await import(base+'scripts/test-support/dsh-sdk-storage.mjs')
const {FrameworkRoleRuntime}=await import(base+'src/framework/role-runtime.ts')
const {FrameworkService}=await import(base+'src/framework/service.ts')
const {PhysicalLocalFiles}=await import(base+'src/framework/physical-local-files.ts')
const {withSnapshot}=await import(base+'src/framework/transactions.ts')
const {paths,taskLifecycleKey}=await import(base+'src/framework/task-files.ts')
const sdk=process.env.DSS_SDK_HOST_ROOT
const req=createRequire(path.join(sdk,'entry.mjs')),pkg=async n=>import(pathToFileURL(req.resolve(n)))
const {Session,SESSION_FORMAT_VERSION}=await pkg('@deepseek-ai/dsh-session'),{SystemPrompt}=await pkg('@deepseek-ai/dsh-system-prompt'),{ToolRuntime}=await pkg('@deepseek-ai/dsh-tools'),{createScope}=await pkg('@deepseek-ai/dsh-scope'),{SessionProjectionRegistry}=await pkg('@deepseek-ai/dsh-session-projection'),{AgentLoop}=await pkg('@deepseek-ai/dsh-agent-loop')
const role=process.env.DSS_NORMAL_ROLE??'Planner',route=role==='Planner'?'P':'O'
const root=await fs.mkdtemp(path.join(tmpdir(),'dss-normal-cleaner-')),events=[],errors=[],nativeRetired=[],scopes=[]
let rt,files,storage,service
const log=(name,value={})=>{events.push({name,...value});console.log(JSON.stringify({name,...value}))}
try {
 storage=await openDshStorageFixture(path.join(root,'records'),path.join(root,'locator'))
 files=new PhysicalLocalFiles(path.join(root,'files'))
 const records=storage.adapter,ctx=storage.ctx,sessions=new Map(),handles=new Map()
 new SystemPrompt(ctx,{});new ToolRuntime(ctx);new SessionProjectionRegistry(ctx)
 ctx.provide('agents',{get:id=>[...handles.values()].find(h=>h.sessionId===id)?.actualAgent,setFactory:()=>()=>{}})
 ctx.provide('sessions',{get:id=>sessions.get(id),flush:async()=>{}})
 ctx.provide('sessionPersistence',{stat:async id=>sessions.has(id)?{sizeBytes:1}:undefined})
 ctx.provide('jobs',{list:()=>[]})
 ctx.provide('nativeSessionCleaner',{register:()=>({closed(){}}),retire:async id=>{nativeRetired.push(id)}})
 new AgentLoop(ctx,{agents:[],maxParallelToolCalls:1})
 const scope='normal-cleaner-evidence',instanceUUID='11111111-1111-4111-8111-111111111111'
 rt=new FrameworkRoleRuntime(ctx,files,records,{scope,mode:'local',member:'A',primary:true,collaborationId:'test',workerSeats:1,workspace:root,instanceUUID},{sharedRecords:records,members:()=>['A'],resources:()=>[],heartbeat:async()=>{},error:(e,context)=>{errors.push({error:String(e),context});log('runtime-error',{error:String(e),nested:e instanceof AggregateError ? e.errors.map(x=>({message:String(x),stack:x?.stack,phase:x?.phase})) : [],context});return true}})
 const add=(owned,type,data,extra={})=>{owned.actualAgent.session.append(type,data,extra);const e=owned.actualAgent.session.snapshotEvents().at(-1);ctx.emit('session/event',owned.actualAgent.session,e);return e}
 rt.gateway.exists=async()=>false
 rt.native.get=(key,id)=>{const h=handles.get(key);return !id||h?.identity.executionId===id?h:undefined}
 rt.native.open=async(identity,options)=>{
  const session=new Session(options.sessionId,undefined,{id:options.sessionId,version:SESSION_FORMAT_VERSION,createdAt:Date.now(),cwd:options.cwd,isSeeded:false,delegationDepth:0}),actualAgent={id:options.sessionId,session,status:'running',inbox:{nextTurn:[],nextStep:[]}}
  const scope=createScope(ctx,actualAgent);scopes.push(scope);options.setup(scope.ctx,actualAgent);sessions.set(options.sessionId,session)
  const received=new Set(),owned={identity,sessionId:options.sessionId,actualAgent,observe:()=>({state:actualAgent.status}),hasMessage:id=>received.has(id),send:async(text,id)=>{
   if(received.has(id))return;received.add(id);owned.turn=(owned.turn??0)+1;actualAgent.status='running';add(owned,'turn/start',{turn:owned.turn});add(owned,'user/message',{id,role:'user',content:[{type:'text',text}],source:{kind:'deepseek-servant'}},{surfaceOp:'append'})
  }}
  handles.set(identity.workId,owned);log('native-open',{role:identity.role,taskId:identity.taskId,executionId:identity.executionId});return owned
 }
 rt.native.stop=async(workId,executionId)=>{
  const h=handles.get(workId);if(!h||h.identity.executionId!==executionId)return {status:'superseded'}
  add(h,'turn/end',{turn:h.turn??1,reason:{kind:'interrupted'}});h.actualAgent.status='closed';handles.delete(workId)
  log('controlled-native-stop-success',{role:h.identity.role,executionId});return {status:'stopped'}
 }
 rt.native.cancelOpening=async(workId,executionId)=>rt.native.stop(workId,executionId)
 const drain=async()=>{
  await rt.pumping
  await Promise.allSettled([...rt.admissions.values(),...(rt.workOperations?.values()??[]),...[...rt.stopOperations?.values()??[]].map(x=>x.promise),...rt.restoreOperations?.values()??[]])
  while(rt.maintenance?.size)await Promise.allSettled([...rt.maintenance.values()])
 }
 const poll=async()=>{await rt.loop.poll();await Promise.allSettled([...rt.loop.sourceOperations.values(),...rt.loop.taskOperations]);await rt.restoring;await drain()}
 const ownedRole=role=>[...handles.values()].find(h=>h.identity.role===role)
 const call=async(owned,name,input,callId)=>{
  const turn=owned.turn??1
  add(owned,'assistant/message',{turn,step:0,message:{id:'model-'+callId,role:'assistant',source:{kind:'model',provider:'controlled',model:'controlled'},content:[{type:'tool-call',id:callId,name,arguments:JSON.stringify(input)}]}},{surfaceOp:'append'})
  const c=add(owned,'tool/call',{turn,step:0,callId,name,arguments:JSON.stringify(input)})
  const r=await ctx.tools.execute({name,arguments:input,agent:owned.actualAgent,callId,signal:new AbortController().signal})
  add(owned,'tool/result',{turn,step:0,message:{...(r.isError?{isError:true}:{}),id:'result-'+callId,role:'tool',toolCallId:callId,source:{kind:'tool',callId},content:[{type:'text',text:JSON.stringify(r.isError?r:r.value)}]}},{surfaceOp:'append',sourceEventSeqs:[c.seq]})
  log('tool-result',{role:owned.identity.role,tool:name,callId,result:r.isError?r:r.value});assert.ok(!r.isError,JSON.stringify(r));return r.value
 }
 const finish=async owned=>{add(owned,'turn/end',{turn:owned.turn??1,reason:{kind:'completed'}});owned.actualAgent.status='idle';ctx.emit('agent/status',{agent:owned.actualAgent});await drain()}

 const connection={scope,files,records,sharedRecords:records,identity:{instanceUUID},registration:{member:'A'}}
 const settings={name:'Evidence',userName:'A',localDirectory:files.directory,ownerRepo:'',repositoryDirectory:'/',collaborationId:'test',workerSeats:1,workspace:root}
 service=new FrameworkService(ctx,records,settings)
 service.saved.set('local',{revision:'fixture',settings});service.running.set('local',{connection,runtime:rt,resources:[]})
 const access={connection,commandHostKey:'normal-cleaner-evidence'}
 service.accesses.set('local',Promise.resolve(access));service.access=async()=>access
 const read=p=>withSnapshot(files,s=>files.read(s,p))
 const view=async stage=>{const v=await service.view({mode:'local',panelsOnly:true});log('actual-service-view',{stage,tasks:v.tasks.map(t=>({taskId:t.taskId,status:t.status,archived:t.archived,executions:t.executions})),executions:v.executions,errors:v.errors,reported:[...service.reportedErrors]});return v}
 await files.replace('tasks/normal_'+route+'.md','Complete the original task and preserve the final record.')
 for(let i=0;i<8&&!ownedRole(role);i++)await poll()
 const manager=ownedRole(role);assert.ok(manager);const taskId=manager.identity.taskId
 await view('manager-running')
 const mv=await call(manager,'dss_snapshot',{},'manager-snapshot')
 await call(manager,'dss_complete',{snapshotId:mv.snapshotId,acceptance:'The requested normal work is complete.',resultPaths:[]},'manager-complete')
 await finish(manager)
 await view('manager-complete-before-recorder-poll')
 for(let i=0;i<8&&!ownedRole('Recorder');i++)await poll()
 const recorder=ownedRole('Recorder');assert.ok(recorder)
 await view('recorder-admitted')
 const rv=await call(recorder,'dss_snapshot',{},'recorder-snapshot')
 await call(recorder,'dss_recorder_save',{snapshotId:rv.snapshotId,outputs:[{path:rv.archiveRecordsPath,text:'# Normal complete task\nOriginal work and accepted result preserved.\n'}],retainedPaths:[]},'recorder-save')
 await finish(recorder)
 assert.equal(await read(paths.state('A',taskId)+'/Cleaner'),'')
 const handoff=await view('cleaner-handoff-after-recorder-idle')
 // The Stop target comes only from the actual view, not a fabricated identity.
 const target=handoff.tasks.find(t=>t.taskId===taskId)?.executions.find(e=>e.role===role)
 assert.ok(target);assert.equal(target.state,'idle')
 // Use the public Stop and Host poll; control only the ordering of the real completion.
 // Controlled scheduling only: hold the actual settle call after the real
 // Service request was accepted, then let the real Host Cleaner run.
 const settleEntered={};settleEntered.promise=new Promise(r=>settleEntered.resolve=r)
 const settleRelease={};settleRelease.promise=new Promise(r=>settleRelease.resolve=r)
 const originalSettle=rt.controls.settleExecution.bind(rt.controls)
 rt.controls.settleExecution=async(...args)=>{log('real-settle-entered',{commandId:args[0]});settleEntered.resolve();await settleRelease.promise;return originalSettle(...args)}
 const stop=await service.stopExecution({mode:'local',storageScope:handoff.storageScope,commandId:'user-stop-'+role,workId:target.workId,executionId:target.executionId})
 log('real-service-stop-accepted',stop);assert.equal(stop.submitted,true)
 await settleEntered.promise
 const cleanup=rt.loop.poll()
 await cleanup
 const gone=await files.entryInfo(paths.run(taskId))===undefined
 log('after-cleaner-before-settle',{taskRunGone:gone})
 assert.equal(gone,true,'Cleaner must not wait for native Stop settlement')
 settleRelease.resolve();await drain()
 for(let pass=1;;pass++) {
  await Promise.allSettled([...rt.loop.physicalReleaseOperations.values(),...rt.loop.physicalCleanupOperations.values()]);await drain()
  const metadata=await read(paths.task(taskId)),cleanup=rt.loop.record.completed[taskLifecycleKey({taskId,lifecycleId:manager.identity.lifecycleId})]?.cleanup
  log('original-cleanup-state',{pass,metadataPresent:metadata!==undefined,cleanupPresent:!!cleanup,resourceOperations:rt.loop.physicalReleaseOperations.size,directoryOperations:rt.loop.physicalCleanupOperations.size,originalRolePresent:rt.roleRecords.has(manager.identity.workId)})
  if(metadata===undefined&&!cleanup)break
  // Collection limit only, never a product wait or a claim that a later poll fixes errors.
  assert.ok(pass<8,'Original cleanup remains pending after the evidence collection budget')
  await poll()
 }
 await view('after-normal-cleaner-poll')
 assert.equal(await read(paths.task(taskId)),undefined)
 assert.ok(await read(rv.archiveRecordsPath));assert.deepEqual(errors,[])
 log('summary',{role,nativeRetired,errors,boundary:'Full production Runtime and Service.view, registered tools and SDK Session; physical Local files/SDK technical store. Native open/send/stop success, model events, flush/stat and retirement acceptance are controlled ports. One controlled temporary wait orders actual operations; no injected I/O/native failure or interrupted process. No real browser/model/native persistence/Windows claimed.',...evidence()})
} finally {
 if(rt){rt.closed=true;for(const scope of scopes)await scope.dispose();await rt.foregroundActivity?.dispose();await rt.observations.dispose()}
 if(files)await files.close();if(storage)await storage.close();hooks.deregister();await fs.rm(root,{recursive:true,force:true})
}
