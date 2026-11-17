// Read-only current production consume-wake lifecycle audit. No receipt deletion. Isolated cache-only candidate, never main-source edits.
// Actual installed SDK; native Agent execution/flush and transport faults controlled.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import {AsyncLocalStorage} from 'node:async_hooks'
import {tmpdir} from 'node:os'
const expected=process.argv[2]??'baseline';assert(['baseline','candidate'].includes(expected));
const selected=fileURLToPath(new URL('../',import.meta.url));process.env.DSS_AUDIT_SOURCE_ROOT=selected;const label='candidate'
const {hash,evidence,hooks,sdkHostRoot}=await import(pathToFileURL(selected+'/scripts/test-support/dsh-sdk-runtime.mjs'))
const require=createRequire(path.join(sdkHostRoot,'helper-signal-readonly.mjs')),pkg=async n=>import(pathToFileURL(require.resolve(n)))
const {Context}=await pkg('@deepseek-ai/cordis'),{Session,interruptedTurnClosers}=await pkg('@deepseek-ai/dsh-session'),{SystemPrompt}=await pkg('@deepseek-ai/dsh-system-prompt')
const {ToolRuntime}=await pkg('@deepseek-ai/dsh-tools'),{createScope}=await pkg('@deepseek-ai/dsh-scope'),{SessionProjectionRegistry}=await pkg('@deepseek-ai/dsh-session-projection'),{AgentLoop}=await pkg('@deepseek-ai/dsh-agent-loop')
const src=pathToFileURL(selected+'/src/'),{gitFixture}=await import('./test-support/helper-consume-git-fixture.mjs')
const {FrameworkRoleRuntime}=await import(new URL('framework/role-runtime.ts',src)),{GitAuthorityStore}=await import(new URL('framework/git-authority.ts',src))
const {withSnapshot,FilesOutcomeUnknownError}=await import(new URL('framework/transactions.ts',src)),{GitBackendError}=await import(new URL('experimental/private-git/git-object-backend.ts',src))
const {initializeTask,paths,readJson}=await import(new URL('framework/task-files.ts',src)),{taskCommandReceiptPath}=await import(new URL('framework/task-command-paths.ts',src))
const root=await fs.mkdtemp(path.join(process.env.DSS_EVIDENCE_ROOT ?? tmpdir(),'dss-helper-consume-')),dir=root,trace=new AsyncLocalStorage(),checks=[],results=[],opened=[],failures=[]
const check=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);checks.push({name,actual});console.error('CHECK '+checks.length+': '+name)}
const reject=async(name,fn,re)=>{let e;try{await fn()}catch(error){e=error}assert.match(String(e),re,name);checks.push({name,error:String(e)});return e}
async function fixture(name,prior){
 const objects=prior?.objects??path.join(root,name+'.git'),state={loseAck:false,committed:true,unavailable:false},commands=[],errors=[],opens=[],receiptReads=[],scopes=[],sessions=new Map(),handles=new Map()
 let g;g=gitFixture(objects,'sha1',async command=>{
  commands.push({...command,stage:trace.getStore()})
  if(state.unavailable&&command.op==='fetchHead')throw new GitBackendError('transport','Controlled consumption resolution unavailable')
  if(state.loseAck&&trace.getStore()==='wake-consumption'&&command.op==='push'){
   state.loseAck=false;if(state.committed)g.git(['update-ref',command.ref,command.commit,command.expected]);state.unavailable=true
   throw new GitBackendError('transport','Controlled consumption acknowledgement loss')
  }
 },!!prior)
 const files=g.files,records=new GitAuthorityStore(files,'helper-signal'),shared=new GitAuthorityStore(files,'shared'),ctx=new Context()
 new SystemPrompt(ctx,{});new ToolRuntime(ctx);new SessionProjectionRegistry(ctx)
 ctx.provide('agents',{get:id=>[...handles.values()].find(h=>h.sessionId===id)?.actualAgent,setFactory:()=>()=>{}})
 ctx.provide('sessions',{get:id=>sessions.get(id),flush:async()=>true});ctx.provide('sessionPersistence',{stat:async id=>sessions.has(id)?{sizeBytes:1}:undefined});ctx.provide('jobs',{list:()=>[]})
 new AgentLoop(ctx,{agents:[],maxParallelToolCalls:1})
 const config={scope:'helper-signal',mode:'git',member:'A',primary:true,collaborationId:'helper-signal-chat',workerSeats:1,workspace:root,instanceUUID:'11111111-1111-4111-8111-111111111111'}
 const rt=new FrameworkRoleRuntime(ctx,files,records,config,{sharedRecords:shared,members:()=>['A'],resources:()=>[],error:(e,origin)=>{errors.push({error:String(e),origin});return true}})
 const run=rt.transactions.run.bind(rt.transactions);rt.transactions.run=(id,...args)=>id.startsWith('consume-wake/')?trace.run('wake-consumption',()=>run(id,...args)):run(id,...args)
 const receipt=rt.transactions.committedReceipt.bind(rt.transactions);rt.transactions.committedReceipt=async(id,...args)=>{const value=await receipt(id,...args);receiptReads.push({id,present:!!value});return value}
 const add=(owned,type,data,extra={})=>{owned.actualAgent.session.append(type,data,extra);const event=owned.actualAgent.session.snapshotEvents().at(-1);ctx.emit('session/event',owned.actualAgent.session,event);return event}
 rt.gateway.exists=async()=>false;rt.native.get=(key,id)=>{const h=handles.get(key);return !id||h?.identity.executionId===id?h:undefined}
 rt.native.open=async(identity,options)=>{
  opens.push(identity);const session=new Session(options.sessionId),actualAgent={id:options.sessionId,session,status:'running',inbox:{nextTurn:[],nextStep:[]}},scope=createScope(ctx,actualAgent)
  scopes.push(scope);options.setup(scope.ctx,actualAgent);sessions.set(options.sessionId,session)
  const received=new Set(),owned={identity,sessionId:options.sessionId,actualAgent,observe:()=>({state:actualAgent.status}),hasMessage:id=>received.has(id),send:async(text,id)=>{if(received.has(id))return;if(state.holdSend){state.holdSend.enter();await state.holdSend.promise}received.add(id);add(owned,'turn/start',{turn:1});add(owned,'user/message',{id,role:'user',content:[{type:'text',text}],source:{kind:'deepseek-servant'}},{surfaceOp:'append'})}}
  handles.set(identity.workId,owned);return owned
 }
 const own=()=>rt.roleRecords.get(rt.roleKey('Helper')),owned=()=>own()?rt.native.get(own().identity.workId):undefined
 const wakeKey=id=>rt.prefix+'wakes/'+hash(id),receiptPath=id=>'technical/command-receipts/'+hash(id)+'.json'
 const drain=async()=>{while(rt.maintenance.size)await Promise.all([...rt.maintenance.values()]);await new Promise(setImmediate)}
 const read=p=>withSnapshot(files,s=>files.read(s,p)),inventory=()=>withSnapshot(files,async s=>({revision:s.revision,receipts:await Promise.all((await files.list(s,'technical/command-receipts/')).map(async row=>({path:row.path,value:JSON.parse(await files.read(s,row.path))}))),signals:await files.listDirectory(s,'state/')}))
 const poll=async()=>{await Promise.all(await rt.loop.signalPoll(files.readRound('host-poll')));await rt.pumping;await Promise.all([...rt.admissions.values()])}
 const call=async(name,input,callId)=>{
  const agent=owned().actualAgent,call=add(owned(),'tool/call',{turn:1,step:0,callId,name,arguments:JSON.stringify(input)})
  const r=await ctx.tools.execute({name,arguments:input,agent,callId,signal:new AbortController().signal})
  add(owned(),'tool/result',{turn:1,step:0,message:{...(r.isError?{isError:true}:{}),id:'result-'+callId,role:'tool',toolCallId:callId,source:{kind:'tool',callId},content:[{type:'text',text:JSON.stringify(r.isError?r:r.value)}]}},{surfaceOp:'append',sourceEventSeqs:[call.seq]});if(r.isError)throw Error(JSON.stringify(r));return r.value
 }
 const idle=async()=>{owned().actualAgent.status='idle';ctx.emit('agent/status',{agent:owned().actualAgent});await Promise.allSettled([...rt.workOperations.values()]);await drain()}
 const finish=async()=>{add(owned(),'turn/end',{turn:1,reason:{kind:'completed'}});await idle()}
 const close=async()=>{rt.closed=true;for(const s of scopes)await s.dispose();await rt.foregroundActivity.dispose();await rt.observations.dispose();await rt.transactions.closeGitSession(Error('Controlled connection loss'));await records.close();await shared.close();await g.repo.releaseCache();opened.splice(opened.indexOf(f),1)}
 const f={objects,g,files,rt,records,state,commands,errors,opens,receiptReads,sessions,own,owned,wakeKey,receiptPath,drain,read,inventory,poll,call,finish,idle,close};opened.push(f);return f
}
const request=id=>({id,role:'Helper',reason:'helper',sources:[],context:{facts:'A real explicit help request fixture'}})
const capture=async(name,f)=>results.push({name,inventory:await f.inventory(),role:f.own(),events:f.owned()?.actualAgent.session.snapshotEvents(),errors:f.errors,commands:f.commands,opens:f.opens,receiptReads:f.receiptReads})
const commandFor=w=>{const signals=[...new Set(w.request.sources.filter(s=>s.path.startsWith('state/')&&s.path.split('/').at(-1)!=='recovery').map(s=>s.path))].sort();return {id:'consume-wake/'+hash(JSON.stringify(['A',w.request.context?.originalWake??w.request.id,signals])),signals}}
const head=f=>f.g.git(['rev-parse','refs/heads/main']).toString().trim()
const pushes=f=>f.commands.filter(c=>c.op==='push'&&c.stage==='wake-consumption').length
async function arrange(f,id){
 await f.rt.services().helper.request({role:'Foreground',workId:'caller',executionId:'caller-execution'},'Controlled actual help input',id)
 await f.drain();await f.poll();return f.records.get(f.wakeKey('help:'+id))
}
async function loadExactRole(f,prior){
 // Inspection boundary: exact persisted role, not a claim to exercise full Host
 // startup/stop reconciliation. No native model or native session reopen here.
 const role=await f.records.get(f.rt.prefix+'roles/'+hash(prior.identity.workId))
 f.rt.roleRecords.set(role.identity.workId,role);(f.rt.roleBases??=new Map()).set(role.identity.workId,structuredClone(role));return role
}
try{
 const f=await fixture('normal'),w=await arrange(f,'normal'),c=commandFor(w)
 check('actual host signal entry delivers original Helper',f.opens.length,1)
 check('before consumption original state exists and no consumption receipt',[await f.read(w.helperSignal),await f.read(f.receiptPath(c.id))],['',undefined])
 await Promise.all([f.call('dss_snapshot',{},'first-read'),f.call('dss_snapshot',{},'concurrent-read')])
 const saved=await f.read(f.receiptPath(c.id))
 check('real registered concurrent reads share one original consumption commit',pushes(f),1)
 check('receipt confirms exact consume command and arguments',[JSON.parse(saved).id,JSON.parse(saved).requestHash],[c.id,hash(JSON.stringify({signals:c.signals}))])
 check('signal absent and existing wake consumption flag true',[await f.read(w.helperSignal),(await f.records.get(f.wakeKey(w.request.id))).signalsConsumed],[undefined,true])
 const later='later-input';await f.rt.services().helper.request({role:'Foreground',workId:'caller',executionId:'caller-execution'},'Second actual help input',later);await f.drain()
 const originalResult=await f.call('dss_claim',{},'claim-later');const originalClaim=structuredClone(Object.values(f.own().notificationClaims)[0]);const beforeRole=structuredClone(f.own())
 check('later Helper request uses its separate notification claim',f.own().notificationClaims&&Object.values(f.own().notificationClaims).some(x=>x.helperWakes?.some(r=>r.id==='help:'+later)),true)
 const taskId='20000000-0000-4000-8000-000000000001',source='tasks/independent_P.md'
 await withSnapshot(f.files,s=>f.files.commit(s,[{path:source,content:'Original independent task requirement'}],'Test task source'))
 const plan=await withSnapshot(f.files,s=>initializeTask(f.files,s,source,'A',['A'],taskId));await withSnapshot(f.files,s=>f.files.commit(s,plan.changes,'Actual initializeTask plan'))
 const task=await withSnapshot(f.files,s=>readJson(f.files,s,paths.task(taskId))),owner=f.rt.taskCommandOwner(task),note=paths.member(taskId,'A')+'/Plan_Note.md',taskCommand='independent-task-note'
 await f.rt.transactions.run(taskCommand,{text:'Independent task note'},{reevaluate:true,taskOwner:owner},async()=>[{path:note,content:'Independent task note'}])
 const taskProof=await f.read(taskCommandReceiptPath(owner,taskCommand))
 const beforeFinish=await f.inventory(),finishStart=f.commands.length;await f.finish();const finishCommands=f.commands.slice(finishStart)
 check('Helper retirement leaves actual unrelated Task note and task receipt',[await f.read(note),await f.read(taskCommandReceiptPath(owner,taskCommand))],['Independent task note',taskProof])
 const steady=f.commands.length;await f.idle();check('unchanged successfully retired Helper idle stays zero Git calls',f.commands.length,steady)
 check('actual completed SDK turn settles original owner',f.own().gitSettledWakeId,w.request.id)
 check('plain original and actually returned later wake both retire',[await f.records.get(f.wakeKey(w.request.id)),await f.records.get(f.wakeKey('help:'+later))],[undefined,undefined])
 check('original consume receipt is unchanged after terminal wake retirement',await f.read(f.receiptPath(c.id)),saved)
 check('later consume-later receipt is separate and still retained',beforeFinish.receipts.filter(x=>x.value.id.startsWith('consume-later/')).length,1)
 check('retirement only removes successful no-Task later receipt',(await f.inventory()).receipts,beforeFinish.receipts.filter(row=>expected==='baseline'||!row.value.id.startsWith('consume-later/')))
 check('normal flow does not need storeWake committedReceipt reader',f.receiptReads,[])
 check('normal flow reports no errors',f.errors,[]);await capture('normal-consume-and-terminal-retirement',f)
 check('original Helper has no Task owner',f.own().identity.taskId,undefined)
 check('ordinary later Helper claim has no Task owner',Object.values(f.own().notificationClaims).every(claim=>claim.taskId===undefined),true)
 const binding=f.rt.binding(f.own(),f.own().delivery.request)
 check('settled turn still returns ordinary later original business context',binding.helperNotifications.some(wake=>wake.id==='help:'+later),true)
 const afterClaim=Object.values(f.own().notificationClaims)[0]
 check('business helperWakes remain byte-equivalent',afterClaim.helperWakes,originalClaim.helperWakes)
 check('only consumed sources are emptied',afterClaim.sources,expected==='candidate'?[]:originalClaim.sources)
 check('all source locations survive in existing fields',[...new Set([...afterClaim.initialSignals,...afterClaim.sources.map(s=>s.path)])].sort(),[...new Set([...originalClaim.initialSignals,...originalClaim.sources.map(s=>s.path)])].sort())
 const afterNative=head(f),replayStart=f.commands.length
 const repeated=await f.call('dss_claim',{},'claim-later')
 check('same native claim retry preserves business contexts',repeated.helperNotifications,originalResult.helperNotifications)
 check('same native claim retry preserves source result',repeated.signals,originalResult.signals)
 check('same native claim replay adds no commit',head(f),afterNative)
 const replayCommands=f.commands.slice(replayStart)
 const persisted=await f.records.get(f.rt.prefix+'roles/'+hash(f.own().identity.workId))
 // Cold exact-authority consumer, without invented Host startup or a fake native reopen.
 const prior=f.own(),objects=f.objects;await f.close()
 const cold=await fixture('cold-normal',{objects});await loadExactRole(cold,prior)
 const coldBefore=head(cold),coldCalls=cold.commands.length
 const coldResult=await cold.rt.claimCurrentNotifications(cold.rt.binding(cold.own(),cold.own().delivery.request),Object.keys(persisted.notificationClaims)[0])
 check('cold original claim retains context',coldResult.helperNotifications,originalResult.helperNotifications)
 check('cold original claim retains signal result',coldResult.signals,originalResult.signals)
 check('cold original claim does not rewrite command',head(cold),coldBefore)
 const coldCommands=cold.commands.slice(coldCalls)
 const output={expected,finishCommands,originalClaim,afterClaim,beforeRole,persisted,replayCommands,coldCommands,checks:checks.length,assertions:checks,results,root,binding,...evidence(),limits:'Only original NORMAL no-Task initial/later Helper path extracted from existing consume retirement regression. Real production helper request/state/Host/registered tools/Git objects. Native session send/model/flush are original controlled fixture ports. No injected errors. Fixture flush explicitly reports success as a controlled port; actual JSONL durability is checked separately in native-probe.'}
 await fs.writeFile(path.join(root,'normal-result.json'),JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output,null,2))
}finally{for(const f of [...opened].reverse())await f.close();hooks.deregister()}
