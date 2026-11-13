// Evidence only. No product code or fault/latency injection.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {createRequire} from 'node:module'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
const base=path.resolve(process.env.DSS_FOREGROUND_RESTORE_SOURCE ?? fileURLToPath(new URL('../',import.meta.url)))+'/'
process.env.DSS_AUDIT_SOURCE_ROOT=base.slice(0,-1)
const {hooks,evidence}=await import(base+'scripts/test-support/dsh-sdk-runtime.mjs')
const {gitFixture}=await import(base+'scripts/test-support/helper-consume-git-fixture.mjs')
const {FrameworkRoleRuntime}=await import(base+'src/framework/role-runtime.ts')
const {GitAuthorityStore}=await import(base+'src/framework/git-authority.ts')
const {withSnapshot}=await import(base+'src/framework/transactions.ts')
const sdk=process.env.DSS_SDK_HOST_ROOT
assert.ok(sdk,'DSS_SDK_HOST_ROOT is required')
const req=createRequire(path.join(sdk,'entry.mjs')),pkg=async n=>import(pathToFileURL(req.resolve(n)))
const {Context}=await pkg('@deepseek-ai/cordis'),{Session,ToolCallRecovery,interruptedTurnClosers}=await pkg('@deepseek-ai/dsh-session'),{SystemPrompt}=await pkg('@deepseek-ai/dsh-system-prompt'),{ToolRuntime}=await pkg('@deepseek-ai/dsh-tools'),{createScope}=await pkg('@deepseek-ai/dsh-scope'),{SessionProjectionRegistry}=await pkg('@deepseek-ai/dsh-session-projection'),{AgentLoop}=await pkg('@deepseek-ai/dsh-agent-loop')
const hash=x=>createHash('sha256').update(x).digest('hex')
const fixed=process.env.DSS_FOREGROUND_RESTORE_FIXED!=='0'
const mode='Foreground'
const evidenceDir=process.env.DSS_FOREGROUND_RESTORE_EVIDENCE
const originalInput='User explicitly requests restoring this current Foreground execution while preserving its current input.'
const root=await fs.mkdtemp(path.join(tmpdir(),'dss-role-restore-')),events=[],errors=[],nativeRetired=[],scopes=[]
let rt,g,records,shared
const historicalBodies=new Map()
const log=(name,value={})=>{events.push({name,...value});console.log(JSON.stringify({name,...value}))}
try {
 g=gitFixture(path.join(root,'repo.git'),'sha1');records=new GitAuthorityStore(g.files,'member-A');shared=new GitAuthorityStore(g.files,'shared')
 if(process.env.DSS_FOREGROUND_RESTORE_HISTORY){
  // Reuse actual baseline-produced completed history, without synthesizing a
  // failure, changing its fields or executing the old tool call again.
  const folder=process.env.DSS_FOREGROUND_RESTORE_HISTORY
  const recorded=JSON.parse(await fs.readFile(path.join(folder,'events.json'),'utf8'))
  const accepted=recorded.find(event=>event.name==='restore-accepted')
  const historyGit=args=>execFileSync('git',['--git-dir='+path.join(folder,'repo.git'),...args]).toString()
  const command=accepted.commandId,paths=historyGit(['ls-tree','-r','--name-only','refs/heads/main']).trim().split('\n')
  const row=paths.find(p=>p.endsWith('/restores/'+hash(command)+'.json'));assert.ok(row)
  const receipt='dss-coop/technical/command-receipts/'+hash('restore-debug:'+command)+'.json'
  const debug='dss-coop/debug/'+accepted.row.createdAt.slice(0,10)+'.md'
  for(const p of [row,receipt,debug])historicalBodies.set(p.slice('dss-coop/'.length),historyGit(['show','refs/heads/main:'+p]))
  assert.equal(JSON.parse(historicalBodies.get(row.slice('dss-coop/'.length))).value.complete,true)
  await withSnapshot(g.files,s=>g.files.commit(s,[...historicalBodies].map(([path,content])=>({path,content})),'Seed actual completed baseline history for preservation check'))
 }
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
 await rt.wake({id:'user-request-foreground',role:'Foreground',reason:'user-resume',sources:[],context:{originalInput}})
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
 const read=p=>withSnapshot(g.files,s=>g.files.read(s,p))
 const debug='debug/'+accepted.createdAt.slice(0,10)+'.md',rowPath=records.deleteChange(key).path
 const debugInitial=await read(debug)??''
 const originalReceipts=g.git(['ls-tree','-r','--name-only','refs/heads/main']).toString().split('\n').filter(p=>p.startsWith('dss-coop/technical/command-receipts/'))
 assert.ok(originalReceipts.length>0,'Actual notification/snapshot receipt exists for preservation check')
 const originalReceiptBodies=new Map(originalReceipts.map(p=>[p,g.git(['show','refs/heads/main:'+p]).toString()]))
 for(let i=0;i<8;i++){await poll();const row=await records.get(key);log('normal-poll-restoration',{pass:i+1,rowPresent:!!row,row});if(fixed?!row:row?.complete)break}
 const completed=await records.get(key)
 if(fixed)assert.equal(completed,undefined,'Normal completion retires exact original responsibility')
 else assert.equal(completed?.complete,true,'Baseline normal completion keeps original responsibility')
 const debugBefore=await read(debug),receiptAfter=await read(receipt)
 assert.ok(debugBefore?.includes(input.facts));assert.equal(receiptAfter!==undefined,!fixed)
 assert.ok(debugBefore.startsWith(debugInitial),'Original Debug text is preserved verbatim')
 const debugEntries=debugBefore.slice(debugInitial.length).split('\n').filter(x=>x.trim());assert.equal(debugEntries.length,1)
 assert.deepEqual(JSON.parse(debugEntries[0]),input,'Exactly this restore input is newly appended')
 // The invocation count is observed scheduling, not a production requirement.
 const debugCalls=transactionCalls.filter(x=>x.id==='restore-debug:'+commandId);assert.ok(debugCalls.length>0,'Restore invoked the actual Debug command at least once')
 const history=g.git(['log','--format=%H','refs/heads/main','--','dss-coop/'+receipt]).toString().trim().split('\n')
 assert.equal(history.length,fixed?2:1,'Exactly one receipt publication; candidate also has one retirement')
 let retirementPaths=[],retirementParent
 if(fixed){
  const commit=history[0];retirementParent=commit+'^'
  retirementPaths=g.git(['diff-tree','--no-commit-id','--name-status','-r',commit]).toString().trim().split('\n').sort()
  assert.deepEqual(retirementPaths,['D\tdss-coop/'+receipt,'D\tdss-coop/'+rowPath].sort())
  const parentRow=JSON.parse(g.git(['show',retirementParent+':dss-coop/'+rowPath]).toString()).value
  assert.equal(parentRow.complete,false,'Original incomplete row becomes absent without extra completion write')
  assert.equal(g.git(['show',retirementParent+':dss-coop/'+debug]).toString(),debugBefore)
  const continuationPath=records.deleteChange(rt.prefix+'wakes/'+hash('restore-role:'+commandId)).path
  const savedContinuation=JSON.parse(g.git(['show',retirementParent+':dss-coop/'+continuationPath]).toString()).value
  assert.equal(savedContinuation.request.context.originalInput,originalInput)
  assert.equal(savedContinuation.recovery.targetExecutionId,target.identity.executionId)
  log('exact-retirement',{commit,parentRow,retirementPaths,continuation:savedContinuation})
 }
 const recovered=new ToolCallRecovery();for(const event of helper.actualAgent.session.snapshotEvents())recovered.observe(event)
 assert.deepEqual(recovered.results(),[],'Actual appended restore result clears SDK pending call')
 const closers=interruptedTurnClosers(helper.actualAgent.session.snapshotEvents())
 assert.equal(closers.some(event=>event.type==='tool/result'),false,'Cold close of actual current log does not replay consumed restore tool')
 log('completed-before-helper-idle',{fixed,rowPresent:!!completed,complete:completed?.complete,outcome:completed?.outcome,taskOwner:completed?.taskOwner,debugEntries,receiptPresent:receiptAfter!==undefined,debugCallCount:debugCalls.length,debugCalls,retirementPaths,helperLog:helper.actualAgent.session.snapshotEvents(),sdkClosers:closers})
 await finish(helper);await poll()
 assert.equal(await read(debug),debugBefore)
 assert.equal((await read(receipt))!==undefined,!fixed)
 if(fixed)assert.equal(await records.get(key),undefined);else assert.equal((await records.get(key)).complete,true)
 const continued=ownedRole('Foreground');assert.ok(continued);assert.notEqual(continued.identity.executionId,target.identity.executionId)
 const restoredInput=continued.actualAgent.session.snapshotEvents().filter(e=>e.type==='user/message').map(e=>e.data.content).flat().filter(c=>c.type==='text').map(c=>c.text).join('\n')
 assert.ok(restoredInput.includes(originalInput));assert.ok(restoredInput.includes(input.continuation))
 for(const [p,body] of originalReceiptBodies)assert.equal(g.git(['show','refs/heads/main:'+p]).toString(),body,'Other original receipt body preserved: '+p)
 const recoveryFiles=g.git(['ls-tree','-r','--name-only','refs/heads/main']).toString().split('\n').filter(p=>p.endsWith('/recovery'));assert.deepEqual(recoveryFiles,[])
 log('after-helper-idle-and-normal-poll',{rowPresent:!!await records.get(key),receiptPresent:(await read(receipt))!==undefined,debugUnchanged:(await read(debug))===debugBefore,recoveryFiles,otherReceiptBodiesPreserved:originalReceiptBodies.size,continued:continued.identity,restoredInput})
 for(const [p,body] of historicalBodies){
  if(p.startsWith('debug/'))assert.ok((await read(p)).startsWith(body),'Existing Debug is retained before new actual entry')
  else assert.equal(await read(p),body,'Existing completed history is unchanged: '+p)
 }
 log('historical-preservation',{historicalFiles:historicalBodies.size})
 if(evidenceDir){await fs.mkdir(evidenceDir,{recursive:true});await fs.cp(path.join(root,'repo.git'),path.join(evidenceDir,'repo.git'),{recursive:true});await fs.writeFile(path.join(evidenceDir,'events.json'),JSON.stringify(events,null,2)+'\n');await fs.writeFile(path.join(evidenceDir,'git-history.txt'),g.git(['log','--format=fuller','--name-status','refs/heads/main']))}
 assert.deepEqual(errors,[])
 log('summary',{mode,fixed,errors,...evidence(),scope:'Production registered dss_restore, Runtime/HostLoop and actual SDK Session/ToolRuntime; real local Git objects/CAS. Native Agent/open/send/stop success, event delivery, flush and native retirement acceptance/auth/transport controlled. No fault/latency injection. Not real model, native persistence, Windows or GitHub.'})
}finally{
 if(rt){rt.closed=true;for(const scope of scopes)await scope.dispose();await rt.foregroundActivity?.dispose();await rt.observations.dispose();await rt.transactions.closeGitSession(Error('Evidence fixture complete'))}
 if(records)await records.close();if(shared)await shared.close();if(g){g.files.operations.close();await g.repo.releaseCache()}
 hooks.deregister();await fs.rm(root,{recursive:true,force:true})
}
