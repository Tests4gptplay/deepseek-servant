// Evidence only. No product code or fault/latency injection.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {createRequire} from 'node:module'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
const base=path.resolve(process.env.DSS_ROLE_RESTORE_SOURCE ?? fileURLToPath(new URL('../',import.meta.url)))+'/'
process.env.DSS_AUDIT_SOURCE_ROOT=base.slice(0,-1)
const {hooks}=await import(base+'scripts/test-support/dsh-sdk-runtime.mjs')
const {gitFixture}=await import(base+'scripts/test-support/helper-consume-git-fixture.mjs')
const {FrameworkRoleRuntime}=await import(base+'src/framework/role-runtime.ts')
const {GitAuthorityStore}=await import(base+'src/framework/git-authority.ts')
const {withSnapshot}=await import(base+'src/framework/transactions.ts')
const {initializeTask,paths,readJson}=await import(base+'src/framework/task-files.ts')
const {readTaskArchiveState,taskArchiveHostFacts}=await import(base+'src/framework/task-archive.ts')
const sdk=process.env.DSS_SDK_HOST_ROOT
assert.ok(sdk,'DSS_SDK_HOST_ROOT is required')
const req=createRequire(path.join(sdk,'entry.mjs')),pkg=async n=>import(pathToFileURL(req.resolve(n)))
const {Context}=await pkg('@deepseek-ai/cordis'),{Session}=await pkg('@deepseek-ai/dsh-session'),{SystemPrompt}=await pkg('@deepseek-ai/dsh-system-prompt'),{ToolRuntime}=await pkg('@deepseek-ai/dsh-tools'),{createScope}=await pkg('@deepseek-ai/dsh-scope'),{SessionProjectionRegistry}=await pkg('@deepseek-ai/dsh-session-projection'),{AgentLoop}=await pkg('@deepseek-ai/dsh-agent-loop')
const hash=x=>createHash('sha256').update(x).digest('hex')
const fixed=process.env.DSS_TASK_RESTORE_FIXED!=='0'
// Ordinary Foreground completion has its own retirement contract and test.
const mode='Planner'
const root=await fs.mkdtemp(path.join(tmpdir(),'dss-role-restore-')),events=[],errors=[],nativeRetired=[],scopes=[]
let rt,g,records,shared
const log=(name,value={})=>{events.push({name,...value});console.log(JSON.stringify({name,...value}))}
try {
 g=gitFixture(path.join(root,'repo.git'),'sha1');records=new GitAuthorityStore(g.files,'member-A');shared=new GitAuthorityStore(g.files,'shared')
 const ctx=new Context(),sessions=new Map(),handles=new Map()
 new SystemPrompt(ctx,{});new ToolRuntime(ctx);new SessionProjectionRegistry(ctx)
 ctx.provide('agents',{get:id=>[...handles.values()].find(h=>h.sessionId===id)?.actualAgent,setFactory:()=>()=>{}})
 ctx.provide('sessions',{get:id=>sessions.get(id),flush:async()=>{}})
 ctx.provide('sessionPersistence',{stat:async id=>sessions.has(id)?{sizeBytes:1}:undefined})
 ctx.provide('jobs',{list:()=>[]})
 ctx.provide('nativeSessionCleaner',{register:()=>({closed(){}}),retire:async id=>{nativeRetired.push(id)}})
 new AgentLoop(ctx,{agents:[],maxParallelToolCalls:1})
 rt=new FrameworkRoleRuntime(ctx,g.files,records,{scope:'role-restore-evidence',mode:'git',member:'A',primary:true,collaborationId:'test',workerSeats:1,workspace:root,instanceUUID:'11111111-1111-4111-8111-111111111111'},{sharedRecords:shared,members:()=>['A'],resources:()=>[],heartbeat:async()=>{},error:(e,context)=>{errors.push({error:String(e),context});log('runtime-error',{error:String(e),context});return true}})
 const transactionCalls=[],run=rt.transactions.run.bind(rt.transactions)
 rt.transactions.run=(id,input,options,...args)=>{transactionCalls.push({id,taskOwner:options?.taskOwner});return run(id,input,options,...args)}
 const add=(owned,type,data,extra={})=>{owned.actualAgent.session.append(type,data,extra);const e=owned.actualAgent.session.snapshotEvents().at(-1);ctx.emit('session/event',owned.actualAgent.session,e);return e}
 rt.gateway.exists=async()=>false
 rt.native.get=(key,id)=>{const h=handles.get(key);return !id||h?.identity.executionId===id?h:undefined}
 rt.native.open=async(identity,options)=>{
  const session=new Session(options.sessionId),actualAgent={id:options.sessionId,session,status:'running',inbox:{nextTurn:[],nextStep:[]}}
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
  await Promise.allSettled([...rt.admissions.values(),...rt.workOperations.values(),...[...rt.stopOperations?.values()??[]].map(x=>x.promise),...rt.restoreOperations?.values()??[]])
  while(rt.maintenance?.size)await Promise.allSettled([...rt.maintenance.values()])
 }
 const poll=async()=>{await rt.loop.poll();await rt.restoring;await drain()}
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
 const id='10000000-0000-4000-8000-000000000211',source='tasks/role-restore-evidence_P.md'
 await withSnapshot(g.files,s=>g.files.commit(s,[{path:source,content:'Exercise the explicit restoration of this Task execution, then preserve its completed record.'}],'Create normal evidence Task'))
 const initialized=await withSnapshot(g.files,s=>initializeTask(g.files,s,source,'A',['A'],id))
 await withSnapshot(g.files,s=>g.files.commit(s,initialized.changes,'Initialize normal evidence Task'));const task=initialized.value
 await poll();const target=ownedRole(mode);assert.ok(target,'Target admitted by actual Host runtime')
 await call(target,'dss_snapshot',{},'target-snapshot')
 await rt.services().helper.request(target.identity,'User explicitly asks to restore this exact '+mode+' execution. Preserve current Task/input; no execution failure is asserted.','request-exact-restore')
 for(let i=0;i<8&&!ownedRole('Helper');i++)await poll();const helper=ownedRole('Helper');assert.ok(helper)
 const helperView=await call(helper,'dss_snapshot',{},'helper-snapshot')
 const notifiedTarget=helperView.helperNotifications.find(wake=>wake.context?.target?.workId===target.identity.workId)?.context.target
 assert.deepEqual(notifiedTarget,target.identity,'Exact target was actually delivered to Helper by dss_snapshot')
 log('actual-target',{target:notifiedTarget,helperView})
 const input={target:notifiedTarget,facts:'User explicitly requested restoration of the current '+mode+' execution.',hypotheses:'Use its actual retained input and current records.',actionsTaken:'Read current registered role and snapshot.',continuation:'Continue the existing responsibility without repeating committed effects.'}
 const restoreCall='restore-normal',commandId=helper.sessionId+':'+restoreCall,key=rt.prefix+'restores/'+hash(commandId),receipt='technical/command-receipts/'+hash('restore-debug:'+commandId)+'.json'
 await call(helper,'dss_restore',input,restoreCall)
 const accepted=await records.get(key);assert.equal(accepted.complete,false);log('restore-accepted',{commandId,row:accepted})
 for(let i=0;i<8;i++){await poll();const row=await records.get(key);log('normal-poll-restoration',{pass:i+1,row});if(row?.complete)break}
 const completed=await records.get(key);assert.equal(completed?.complete,true,'Original restore completed through normal polling')
 const debug='debug/'+completed.createdAt.slice(0,10)+'.md',read=p=>withSnapshot(g.files,s=>g.files.read(s,p))
 const debugBefore=await read(debug),receiptBefore=await read(receipt)
 assert.ok(debugBefore?.includes(input.facts));assert.ok(receiptBefore)
 const debugEntries=debugBefore.split('\n').filter(x=>x.includes(input.facts));assert.equal(debugEntries.length,1)
 const marker=paths.state('A',id)+'/recovery'
 const publicationCommits=g.git(['log','--format=%H','refs/heads/main','--','dss-coop/'+receipt]).toString().trim().split('\n');assert.equal(publicationCommits.length,1)
 const before={debugPath:debug,receiptPath:receipt,receiptPublicationCommits:publicationCommits.length,rowPresent:true,complete:completed.complete,outcome:completed.outcome,taskOwner:completed.taskOwner,debugReceipt:JSON.parse(receiptBefore),debugEntries:debugEntries.length,marker:marker?await read(marker):undefined,restoreDebugCalls:transactionCalls.filter(x=>x.id==='restore-debug:'+commandId)}
 log('completed-before-helper-idle',before)
 await finish(helper);await poll()
 log('after-helper-idle',{row:await records.get(key),receiptPresent:(await read(receipt))!==undefined,debugUnchanged:(await read(debug))===debugBefore})
 assert.equal(await read(debug),debugBefore)
 {
  const continued=ownedRole('Planner');assert.ok(continued);assert.notEqual(continued.identity.executionId,target.identity.executionId)
  const v=await call(continued,'dss_snapshot',{},'continued-snapshot')
  await call(continued,'dss_complete',{snapshotId:v.snapshotId,acceptance:'The requested normal restoration was performed. This evidence Task is complete.',resultPaths:[]},'complete-task')
  await finish(continued);await poll()
  const recorder=ownedRole('Recorder');assert.ok(recorder,'Recorder admitted by actual terminal Task signal')
  const rv=await call(recorder,'dss_snapshot',{},'recorder-snapshot')
  assert.ok(rv.archiveRecordsPath)
  await call(recorder,'dss_recorder_save',{snapshotId:rv.snapshotId,outputs:[{path:rv.archiveRecordsPath,text:'# Completed restoration evidence\n\nThe original Planner was explicitly restored, then this Task completed through its registered tools.\n'}],retainedPaths:[]},'record-task')
  await finish(recorder)
  const cleanerPath=paths.state('A',id)+'/Cleaner';assert.equal(await read(cleanerPath),'')
  const originalReceipts=g.git(['ls-tree','-r','--name-only','refs/heads/main']).toString().split('\n').filter(p=>p.startsWith('dss-coop/technical/command-receipts/'))
  const originalReceiptBodies=new Map(originalReceipts.map(p=>[p,g.git(['show','refs/heads/main:'+p]).toString()]))
  log('before-cleaner',{rowPresent:!!await records.get(key),receiptPresent:!!await read(receipt),debugUnchanged:(await read(debug))===debugBefore,cleanerSignal:await read(cleanerPath),originalReceipts})
  for(let i=0;i<8;i++){await poll();if(!await records.get(key))break}
  const archived=await read(rv.archiveRecordsPath),archiveState=await withSnapshot(g.files,s=>readTaskArchiveState(g.files,s,task))
  const finalRow=await records.get(key);const foregroundNotice='state/Foreground_Task_'+id
  const currentReceipts=g.git(['ls-tree','-r','--name-only','refs/heads/main']).toString().split('\n').filter(p=>p.startsWith('dss-coop/technical/command-receipts/'))
  const removedReceipts=originalReceipts.filter(p=>!currentReceipts.includes(p));assert.deepEqual(removedReceipts,fixed?['dss-coop/'+receipt]:[])
  for(const [p,body] of originalReceiptBodies)if(p!=='dss-coop/'+receipt)assert.equal(g.git(['show','refs/heads/main:'+p]).toString(),body,'Unrelated receipt body preserved: '+p)
  let retirementPaths=[];if(fixed){const deletionCommit=g.git(['log','-1','--format=%H','refs/heads/main','--','dss-coop/'+receipt]).toString().trim();retirementPaths=g.git(['diff-tree','--no-commit-id','--name-only','-r',deletionCommit]).toString().trim().split('\n').sort();assert.deepEqual(retirementPaths,['dss-coop/'+receipt,'dss-coop/'+records.deleteChange(key).path].sort())}
  const after={removedReceipts,otherReceiptBodiesPreserved:originalReceipts.length-1,retirementPaths,row:finalRow,rowPresent:!!finalRow,foregroundTaskSignalPresent:(await read(foregroundNotice))!==undefined,receiptUnchanged:(await read(receipt))===receiptBefore,receiptPresent:(await read(receipt))!==undefined,debugUnchanged:(await read(debug))===debugBefore,archiveRecordsPresent:!!archived,markerPresent:(await read(marker))!==undefined,cleanerSignalPresent:(await read(cleanerPath))!==undefined,taskRunFiles:g.git(['ls-tree','-r','--name-only','refs/heads/main']).toString().split('\n').filter(p=>p.startsWith('dss-coop/task-runs/'+id+'/')),archiveState,nativeRetired}
  log('after-real-cleaner-and-task-release',after)
  assert.equal(after.row,undefined);assert.equal(after.receiptPresent,!fixed);if(!fixed)assert.equal(after.receiptUnchanged,true);assert.equal(after.foregroundTaskSignalPresent,true);assert.equal(after.debugUnchanged,true);assert.ok(after.archiveRecordsPresent);assert.equal(after.taskRunFiles.length,0)
 }
 assert.deepEqual(errors,[])
 log('summary',{mode,fixed,errors,scope:'Production registered dss_restore, Runtime/HostLoop and actual SDK Session/ToolRuntime; real local Git objects/CAS. Native Agent/open/send/stop success, event delivery, flush and native retirement acceptance/auth/transport controlled. No fault/latency injection. Not real model, native persistence, Windows or GitHub.'})
}finally{
 if(rt){rt.closed=true;for(const scope of scopes)await scope.dispose();await rt.foregroundActivity?.dispose();await rt.observations.dispose();await rt.transactions.closeGitSession(Error('Evidence fixture complete'))}
 if(records)await records.close();if(shared)await shared.close();if(g){g.files.operations.close();await g.repo.releaseCache()}
 hooks.deregister();await fs.rm(root,{recursive:true,force:true})
}
