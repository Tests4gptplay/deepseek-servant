// Read-only current production consume-wake lifecycle audit. No receipt deletion. Isolated cache-only candidate, never main-source edits.
// Actual installed SDK; native Agent execution/flush and transport faults controlled.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import {AsyncLocalStorage} from 'node:async_hooks'
import {tmpdir} from 'node:os'
const selected=fileURLToPath(new URL('../',import.meta.url));process.env.DSS_AUDIT_SOURCE_ROOT=selected;const label='candidate'
const {hash,evidence,hooks,sdkHostRoot}=await import(pathToFileURL(selected+'/scripts/test-support/dsh-sdk-runtime.mjs'))
const require=createRequire(path.join(sdkHostRoot,'helper-signal-readonly.mjs')),pkg=async n=>import(pathToFileURL(require.resolve(n)))
const {Context}=await pkg('@deepseek-ai/cordis'),{Session,interruptedTurnClosers}=await pkg('@deepseek-ai/dsh-session'),{SystemPrompt}=await pkg('@deepseek-ai/dsh-system-prompt')
const {ToolRuntime}=await pkg('@deepseek-ai/dsh-tools'),{createScope}=await pkg('@deepseek-ai/dsh-scope'),{SessionProjectionRegistry}=await pkg('@deepseek-ai/dsh-session-projection'),{AgentLoop}=await pkg('@deepseek-ai/dsh-agent-loop')
const src=pathToFileURL(selected+'/src/'),{gitFixture}=await import('./test-support/helper-consume-git-fixture.mjs')
const {FrameworkRoleRuntime}=await import(new URL('framework/role-runtime.ts',src)),{GitAuthorityStore}=await import(new URL('framework/git-authority.ts',src))
const {withSnapshot,FilesOutcomeUnknownError}=await import(new URL('framework/transactions.ts',src)),{GitBackendError}=await import(new URL('experimental/private-git/git-object-backend.ts',src))
const {initializeTask,paths,readJson}=await import(new URL('framework/task-files.ts',src)),{taskCommandReceiptPath}=await import(new URL('framework/task-command-paths.ts',src))
const root=await fs.mkdtemp(path.join(tmpdir(),'dss-helper-consume-')),dir=root,trace=new AsyncLocalStorage(),checks=[],results=[],opened=[],failures=[]
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
 ctx.provide('sessions',{get:id=>sessions.get(id),flush:async()=>{}});ctx.provide('sessionPersistence',{stat:async id=>sessions.has(id)?{sizeBytes:1}:undefined});ctx.provide('jobs',{list:()=>[]})
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
 await f.call('dss_claim',{},'claim-later')
 check('later Helper request uses its separate notification claim',f.own().notificationClaims&&Object.values(f.own().notificationClaims).some(x=>x.helperWakes?.some(r=>r.id==='help:'+later)),true)
 const taskId='20000000-0000-4000-8000-000000000001',source='tasks/independent_P.md'
 await withSnapshot(f.files,s=>f.files.commit(s,[{path:source,content:'Original independent task requirement'}],'Test task source'))
 const plan=await withSnapshot(f.files,s=>initializeTask(f.files,s,source,'A',['A'],taskId));await withSnapshot(f.files,s=>f.files.commit(s,plan.changes,'Actual initializeTask plan'))
 const task=await withSnapshot(f.files,s=>readJson(f.files,s,paths.task(taskId))),owner=f.rt.taskCommandOwner(task),note=paths.member(taskId,'A')+'/Plan_Note.md',taskCommand='independent-task-note'
 await f.rt.transactions.run(taskCommand,{text:'Independent task note'},{reevaluate:true,taskOwner:owner},async()=>[{path:note,content:'Independent task note'}])
 const taskProof=await f.read(taskCommandReceiptPath(owner,taskCommand))
 const beforeFinish=await f.inventory();await f.finish()
 check('Helper retirement leaves actual unrelated Task note and task receipt',[await f.read(note),await f.read(taskCommandReceiptPath(owner,taskCommand))],['Independent task note',taskProof])
 const steady=f.commands.length;await f.idle();check('unchanged successfully retired Helper idle stays zero Git calls',f.commands.length,steady)
 check('actual completed SDK turn settles original owner',f.own().gitSettledWakeId,w.request.id)
 check('plain original and actually returned later wake both retire',[await f.records.get(f.wakeKey(w.request.id)),await f.records.get(f.wakeKey('help:'+later))],[undefined,undefined])
 check('original consume receipt is unchanged after terminal wake retirement',await f.read(f.receiptPath(c.id)),saved)
 check('later consume-later receipt is separate and still retained',beforeFinish.receipts.filter(x=>x.value.id.startsWith('consume-later/')).length,1)
 check('retirement does not remove unrelated command receipts',(await f.inventory()).receipts,beforeFinish.receipts)
 check('normal flow does not need storeWake committedReceipt reader',f.receiptReads,[])
 check('normal flow reports no errors',f.errors,[]);await capture('normal-consume-and-terminal-retirement',f)
 const prior=f.own(),events=f.owned().actualAgent.session.snapshotEvents(),objects=f.objects;await f.close()
 const cold=await fixture('cold-retired',{objects});await loadExactRole(cold,prior)
 check('cold exact retired wake stays absent',await cold.records.get(cold.wakeKey(w.request.id)),undefined)
 check('cold retained role rejects accepted original help id without recreating wake',await cold.rt.wake(w.request),false)
 check('cold old consume receipt remains addressable without any new write',[(await cold.rt.transactions.committedReceipt(c.id,{signals:c.signals})).replay,cold.commands.filter(x=>x.op==='push').length],[true,0])
 await capture('cold-retired-inspection-boundary',cold)

 // Controlled interruption after actual atomic consume commit, before the
 // existing WakeRecord follow-up; all normal requests remain production code.
 const gap=await fixture('metadata-gap'),gw=await arrange(gap,'metadata-gap'),gc=commandFor(gw),update=gap.rt.updateWake.bind(gap.rt);let interrupt=true
 gap.rt.updateWake=(key,fn,...rest)=>update(key,current=>{const next=fn(current);if(interrupt&&key===gap.wakeKey(gw.request.id)&&next?.signalsConsumed)throw Error('Controlled post-consumption WakeRecord interruption');return next},...rest)
 await reject('registered read exposes post-consume metadata interruption',()=>gap.call('dss_snapshot',{},'gap-original'),/Controlled post-consumption/)
 check('gap has committed receipt and absent signal but unmarked wake',[!!await gap.read(gap.receiptPath(gc.id)),await gap.read(gw.helperSignal),(await gap.records.get(gap.wakeKey(gw.request.id))).signalsConsumed],[true,undefined,undefined])
 interrupt=false;const gp=pushes(gap);await gap.call('dss_snapshot',{},'gap-new-read')
 check('next real read completes metadata without another consume push',[pushes(gap), (await gap.records.get(gap.wakeKey(gw.request.id))).signalsConsumed],[gp,true])
 check('same live metadata retry uses transaction replay not storeWake reader',gap.receiptReads,[])
 await gap.finish();check('fixed metadata then actual completion retires wake only',[await gap.records.get(gap.wakeKey(gw.request.id)),!!await gap.read(gap.receiptPath(gc.id))],[undefined,true]);await capture('live-metadata-gap-retry',gap)

 // Original consume transport UNKNOWN: inject only the actual consume push.
 // Both submitted and unsubmitted cases use real objects/ref state, no sleeps.
 for(const committed of [true,false]){
  const u=await fixture('unknown-'+committed),uw=await arrange(u,'unknown-'+committed),uc=commandFor(uw);u.state.loseAck=true;u.state.committed=committed
  await reject('real read reports original consume UNKNOWN '+committed,()=>u.call('dss_snapshot',{},'unknown-read'),/uncertain; resolve the same persisted operation/i)
  check('UNKNOWN original operation retained '+committed,u.rt.transactions.ownsGitAttempt(uc.id),true)
  u.state.unavailable=false
  check('actual ref decides current signal and receipt '+committed,[await u.read(uw.helperSignal),!!await u.read(u.receiptPath(uc.id)),(await u.records.get(u.wakeKey(uw.request.id))).signalsConsumed],[committed?undefined:'',committed,undefined])
  const before=pushes(u)
  if(committed)await u.call('dss_snapshot',{},'unknown-follow-up')
  else await reject('unchanged ref is pending, not proof of no remote commit',()=>u.call('dss_snapshot',{},'unknown-follow-up'),/uncertain; resolve the same persisted operation/i)
  check('live attempt resolves only if commit confirmed '+committed,[pushes(u)-before,u.rt.transactions.ownsGitAttempt(uc.id)],[0,!committed])
  check('live consumption field follows actual outcome '+committed,(await u.records.get(u.wakeKey(uw.request.id))).signalsConsumed,committed?true:undefined)
  await capture('unknown-live-'+committed,u)
 }

 // Cold transaction/consumer boundary uses the same real persisted original
 // role and wake. This is not full Host restart or old SDK call redispatch.
 for(const committed of [true,false]){
  const u=await fixture('cold-unknown-source-'+committed),uw=await arrange(u,'cold-unknown-'+committed),uc=commandFor(uw);u.state.loseAck=true;u.state.committed=committed
  await reject('cold source original read has UNKNOWN '+committed,()=>u.call('dss_snapshot',{},'cold-unknown-read'),/uncertain; resolve the same persisted operation/i)
  u.state.unavailable=false;const pr=u.own(),same={objects:u.objects};await capture('cold-source-'+committed,u);await u.close()
  const r=await fixture('cold-unknown-'+committed,same),loaded=await loadExactRole(r,pr)
  const binding=r.rt.binding(loaded,loaded.delivery.request)
  check('cold exact receipt authority before consume '+committed,!!await r.rt.transactions.committedReceipt(uc.id,{signals:uc.signals}),committed)
  await r.rt.services().consumeWake(binding)
  check('cold consumer retries only uncommitted signal '+committed,pushes(r),committed?0:1)
  check('cold consumer leaves original signal consumed and field completed '+committed,[await r.read(uw.helperSignal),(await r.records.get(r.wakeKey(uw.request.id))).signalsConsumed],[undefined,true])
  await capture('cold-consumer-boundary-'+committed,r)
 }

 // A real Host STATE read can overlap the independently running Helper. Hold
 // the return of its already-read H until consumption+idle, not fake latency.
 const overlap=await fixture('host-observation-overlap'),ow=await arrange(overlap,'overlap'),oc=commandFor(ow)
 let enter,release;const entered=new Promise(r=>enter=r),held=new Promise(r=>release=r);let once=true
 const list=overlap.files.listDirectory.bind(overlap.files)
 overlap.files.listDirectory=async(snapshot,root,options)=>{const value=await list(snapshot,root,options);if(root==='state/'&&trace.getStore()==='held-host-poll'&&once){once=false;enter({revision:snapshot.revision,value});await held}return value}
 const observing=trace.run('held-host-poll',()=>overlap.poll()),seen=await entered
 check('held real Host observation actually contains original source',seen.value.some(s=>s.path===ow.helperSignal&&s.version===ow.request.sources[0].version),true)
 const updateO=overlap.rt.updateWake.bind(overlap.rt),acceptedConsumption=[];let breakField=true
 overlap.rt.updateWake=async(key,fn,...rest)=>{let submitted;const result=await updateO(key,current=>{const next=fn(current);if(breakField&&key===overlap.wakeKey(ow.request.id)&&next?.signalsConsumed)throw Error('Controlled overlap metadata interruption');submitted=next;return next},...rest);if(key===overlap.wakeKey(ow.request.id)&&submitted?.signalsConsumed)acceptedConsumption.push(submitted);return result}
 await reject('overlap read commits deletion then reports metadata gap',()=>overlap.call('dss_snapshot',{},'overlap-read'),/Controlled overlap/)
 await overlap.finish()
 check('completed turn does not retire original wake without consumed field',!!await overlap.records.get(overlap.wakeKey(ow.request.id)),true)
 const cachedBefore=overlap.rt.helperRetirementChecked===overlap.own();breakField=false;release();await observing;await overlap.drain()
 check('existing Host entry actually invokes precise committedReceipt',[overlap.receiptReads.at(-1)?.id,overlap.receiptReads.at(-1)?.present],[oc.id,true])
 check('Host receipt reader marks existing original wake consumed',acceptedConsumption.some(wake=>wake.signalsConsumed),true)
 check('Host receipt check never repeats deletion push or native opening',[pushes(overlap),overlap.opens.length],[1,1])
 const otherWakes=await overlap.records.list(overlap.rt.prefix+'wakes/');results.push({name:'overlap-other-wakes-before-retirement',seen,otherWakes})
 // No second idle event: successful existing wake update must schedule only this retirement.
 const afterIdle=await overlap.records.get(overlap.wakeKey(ow.request.id));results.push({name:'terminal-retry-evidence',cachedBefore,acceptedConsumption,afterIdle})
 try{check('accepted wake update resumes terminal retirement without another idle event',afterIdle,undefined)}catch(error){failures.push({name:'accepted wake update resumes terminal retirement without another idle event',actual:afterIdle,expected:'undefined',error:String(error)});console.error('PRESERVED FAILURE: '+error)}
 check('receipt remains after overlap terminal retry',!!await overlap.read(overlap.receiptPath(oc.id)),true);await capture('host-observation-overlap',overlap)

 // Failure of the existing exact retirement deletion must leave the wake and
 // current receipt. The actual second idle callback retries this known owner.
 const retirement=await fixture('retirement-retry'),rw=await arrange(retirement,'retirement-retry'),rc=commandFor(rw)
 await retirement.call('dss_snapshot',{},'retirement-read');const remove=retirement.records.compareAndDelete.bind(retirement.records);let failDelete=true
 retirement.records.compareAndDelete=(key,value)=>{if(failDelete&&key===retirement.wakeKey(rw.request.id))throw Error('Controlled exact wake retirement interruption');return remove(key,value)}
 await retirement.finish()
 check('failed exact retirement retains settled wake and consumption receipt',[retirement.own().gitSettledWakeId,!!await retirement.records.get(retirement.wakeKey(rw.request.id)),!!await retirement.read(retirement.receiptPath(rc.id))],[rw.request.id,true,true])
 check('existing native error boundary reports failed retirement',retirement.errors.some(e=>e.error.includes('Controlled exact wake retirement')),true)
 failDelete=false;await retirement.idle()
 check('existing second idle retries exact wake without removing receipt',[await retirement.records.get(retirement.wakeKey(rw.request.id)),!!await retirement.read(retirement.receiptPath(rc.id))],[undefined,true]);await capture('retirement-retry',retirement)

 const output={label,checks:checks.length,failures,assertions:checks,results,root,...evidence(),scriptSha256:hash(await fs.readFile(fileURLToPath(import.meta.url))),limits:'Frozen baseline versus isolated retirement-cache candidate; consume receipts unchanged. Actual SDK Context/Scope/Session/ToolRuntime/AgentLoop projections and real local Git objects/CAS. Native model/open/send/status/flush/persistence stat controlled. Cold exact persisted role installed at consumer inspection boundary, not full Host startup or native ownership stop/recovery. Overlap and errors are controlled real-entry ordering, not reported user incidents. No HTTP/Dulwich/GitHub performance test; no deletes of receipt data, main-source edits, new dependencies or global mechanism.'}
 await fs.writeFile(path.join(dir,label+'-measurement-results.json'),JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output,null,2));process.exitCode=failures.length?1:0
}finally{for(const f of [...opened].reverse())await f.close();hooks.deregister();await fs.rm(root,{recursive:true,force:true})}
