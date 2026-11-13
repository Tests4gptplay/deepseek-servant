// Real Host stale-H Helper notification audit; no consumption receipt deletion or main-source edits.
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
const {withSnapshot,withOperationChannel,FilesOutcomeUnknownError}=await import(new URL('framework/transactions.ts',src)),{GitBackendError}=await import(new URL('experimental/private-git/git-object-backend.ts',src))
const {initializeTask,paths,readJson}=await import(new URL('framework/task-files.ts',src)),{taskCommandReceiptPath}=await import(new URL('framework/task-command-paths.ts',src))
const root=await fs.mkdtemp(path.join(tmpdir(),'dss-helper-shadow-')),dir=root,trace=new AsyncLocalStorage(),checks=[],results=[],opened=[],failures=[]
const check=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);checks.push({name,actual});console.error('CHECK '+checks.length+': '+name)}
const reject=async(name,fn,re)=>{let e;try{await fn()}catch(error){e=error}assert.match(String(e),re,name);checks.push({name,error:String(e)});return e}
async function fixture(name,prior,member='A'){
 const objects=prior?.objects??path.join(root,name+'.git'),state={loseAck:false,committed:true,unavailable:false},commands=[],errors=[],opens=[],receiptReads=[],scopes=[],sessions=new Map(),handles=new Map()
 let g;g=gitFixture(objects,'sha1',async command=>{
  commands.push({...command,stage:trace.getStore()})
  if(state.unavailable&&command.op==='fetchHead')throw new GitBackendError('transport','Controlled consumption resolution unavailable')
  if(state.loseAck&&trace.getStore()===(state.failStage??'wake-consumption')&&command.op==='push'){
   state.loseAck=false;if(state.committed)g.git(['update-ref',command.ref,command.commit,command.expected]);state.unavailable=true
   throw new GitBackendError('transport','Controlled consumption acknowledgement loss')
  }
 },!!prior)
 const files=g.files,records=new GitAuthorityStore(files,'helper-signal'),shared=new GitAuthorityStore(files,'shared'),ctx=new Context()
 new SystemPrompt(ctx,{});new ToolRuntime(ctx);new SessionProjectionRegistry(ctx)
 ctx.provide('agents',{get:id=>[...handles.values()].find(h=>h.sessionId===id)?.actualAgent,setFactory:()=>()=>{}})
 ctx.provide('sessions',{get:id=>sessions.get(id),flush:async()=>{}});ctx.provide('sessionPersistence',{stat:async id=>sessions.has(id)?{sizeBytes:1}:undefined});ctx.provide('jobs',{list:()=>[]})
 new AgentLoop(ctx,{agents:[],maxParallelToolCalls:1})
 const config={scope:'helper-signal-'+member,mode:'git',member,primary:true,collaborationId:'helper-signal-chat',workerSeats:1,workspace:root,instanceUUID:'11111111-1111-4111-8111-111111111111'}
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
 const drain=async()=>{while(rt.maintenance?.size)await Promise.all([...rt.maintenance.values()]);await new Promise(setImmediate)}
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
 for(const kind of ['normal-warm','normal-cold-state','metadata-gap']){
  const f=await fixture(kind),w=await arrange(f,kind),c=commandFor(w)
  // An unrelated real Host publishes its own Helper signal in the same Git repo.
  const other=await fixture('other-'+kind,{objects:f.objects},'B')
  await other.rt.services().helper.request({role:'Foreground',workId:'B-caller',executionId:'B-caller-execution'},'Independent B help input','B-'+kind);await other.drain()
  const otherKey=other.wakeKey('help:B-'+kind),otherWake=await other.records.get(otherKey),otherSignal=await other.read(otherWake.helperSignal)
  const taskId='20000000-0000-4000-8000-000000000001',source='tasks/independent_P.md'
  await withSnapshot(f.files,s=>f.files.commit(s,[{path:source,content:'Independent actual task requirement'}],'Original task source'))
  const plan=await withSnapshot(f.files,s=>initializeTask(f.files,s,source,'A',['A'],taskId));await withSnapshot(f.files,s=>f.files.commit(s,plan.changes,'Actual initializeTask plan'))
  const task=await withSnapshot(f.files,s=>readJson(f.files,s,paths.task(taskId))),owner=f.rt.taskCommandOwner(task),note=paths.member(taskId,'A')+'/Plan_Note.md',taskCommand='unrelated-task-note'
  await f.rt.transactions.run(taskCommand,{text:'Independent Task note'},{reevaluate:true,taskOwner:owner},async()=>[{path:note,content:'Independent Task note'}]);const taskProof=await f.read(taskCommandReceiptPath(owner,taskCommand))
  let enter,release;const entered=new Promise(r=>enter=r),held=new Promise(r=>release=r);let once=true
  const list=f.files.listDirectory.bind(f.files)
  f.files.listDirectory=async(snapshot,root,options)=>{const target=root==='state/'&&trace.getStore()==='held-host-poll'&&options?.paths?.length===1&&options.paths[0]===w.helperSignal;const value=await(target?trace.run('source-existence',()=>list(snapshot,root,options)):list(snapshot,root,options));if(root==='state/'&&trace.getStore()==='held-host-poll'&&once){once=false;enter({revision:snapshot.revision,value});await held}return value}
  const observing=trace.run('held-host-poll',()=>f.poll()),seen=await entered
  check(kind+': old real H contains exact initial state',seen.value.some(x=>x.path===w.helperSignal&&x.version===w.request.sources[0].version),true)
  const update=f.rt.updateWake.bind(f.rt);let breakField=kind==='metadata-gap'
  f.rt.updateWake=(key,fn,...rest)=>update(key,(current,snapshot)=>{const next=fn(current,snapshot);if(breakField&&key===f.wakeKey(w.request.id)&&next?.signalsConsumed)throw Error('Controlled metadata interruption');return next},...rest)
  if(kind==='metadata-gap')await reject('registered read exposes actual consumption/metadata gap',()=>f.call('dss_snapshot',{},'read-'+kind),/Controlled metadata interruption/)
  else await f.call('dss_snapshot',{},'read-'+kind)
  await f.finish()
  check(kind+': Helper really consumed original signal',await f.read(w.helperSignal),undefined)
  check(kind+': original wake before stale H return',!!await f.records.get(f.wakeKey(w.request.id)),kind==='metadata-gap')
  const receipt=await f.read(f.receiptPath(c.id));check(kind+': consumption receipt exists',JSON.parse(receipt).id,c.id)
  // Explicit cache preconditions, not performance simulations: warm this exact
  // write-lane state tree, or let another real Host publish a new state tree.
  if(kind==='normal-warm')await trace.run('cache-preparation',()=>withOperationChannel(f.files,'write',()=>withSnapshot(f.files,s=>f.files.listDirectory(s,'state/'))))
  if(kind==='normal-cold-state'){
   await other.rt.services().helper.request({role:'Foreground',workId:'B-caller',executionId:'B-caller-execution'},'Another real B help input','B-cold-state');await other.drain()
  }
  const before=f.commands.length;breakField=false;release();await observing;await f.drain()
  const checkCommands=f.commands.filter(x=>x.stage==='source-existence'),during=f.commands.slice(before)
  const counts=commands=>Object.fromEntries([...new Set(commands.map(x=>x.op))].sort().map(op=>[op,commands.filter(x=>x.op===op).length]))
  results.push({name:kind+'-command-counts',sourceExistence:counts(checkCommands),sourceExistenceCommands:checkCommands,afterOldHReturn:counts(during),channels:Object.fromEntries([...new Set(during.map(x=>x.channel))].map(channel=>[channel,counts(during.filter(x=>x.channel===channel))]))})
  check(kind+': source check does not acquire another HEAD itself',checkCommands.filter(x=>x.op==='fetchHead').length,0)
  const wakes=await f.records.list(f.rt.prefix+'wakes/'),shadows=wakes.filter(x=>x.value.request.id.startsWith('helper-notification:'))
  results.push({name:kind+'-shadow-evidence',seen,shadows,wakes,initial:w})
  check(kind+': no second native admission',f.opens.length,1)
  check(kind+': original completed wake retires by its own existing path',await f.records.get(f.wakeKey(w.request.id)),undefined)
  check(kind+': original consume receipt unchanged',await f.read(f.receiptPath(c.id)),receipt)
  try{check(kind+': stale H creates no never-accepted shadow wake',shadows,[])}catch(error){failures.push({name:kind+': stale H creates no never-accepted shadow wake',actual:shadows,expected:[],error:String(error)});console.error('PRESERVED FAILURE: '+error)}
  if(shadows.length){
   check(kind+': baseline shadow is marked delivered/consumed without native ownership',shadows.map(x=>[x.value.delivered,x.value.signalsConsumed,f.own().delivery.request.id===x.value.request.id]),[[true,true,false]])
   await f.idle();check(kind+': actual next idle does not retire unaccepted shadow',!!await f.records.get(shadows[0].key),true)
  }
  check(kind+': other Host Helper wake and signal untouched',[await other.records.get(otherKey),await other.read(otherWake.helperSignal)],[otherWake,otherSignal])
  check(kind+': actual independent Task note and receipt untouched',[await f.read(note),await f.read(taskCommandReceiptPath(owner,taskCommand))],['Independent Task note',taskProof])
  await capture(kind+'-final',f)
 }
 // Actual helper service creates a WakeRecord before any signal. Lose only
 // that authority write's ACK. The original owned operation remains intact.
 for(const committed of [true,false]){
  const f=await fixture('wake-create-unknown-'+committed),id='wake-create-'+committed,requestId='help:'+id,key=f.wakeKey(requestId)
  const request=()=>trace.run('wake-create',()=>f.rt.services().helper.request({role:'Foreground',workId:'caller',executionId:'caller-execution'},'Original actual help facts',id))
  f.state.loseAck=true;f.state.failStage='wake-create';f.state.committed=committed
  await reject('actual wake creation retains UNKNOWN '+committed,request,/uncertain; resolve the same persisted operation/i)
  check('uncertain authority creation owns original operation '+committed,f.records.ownedAttempts.has(JSON.stringify([key,'wake'])),true)
  f.state.unavailable=false
  check('only actual committed branch has original WakeRecord '+committed,!!await f.records.get(key),committed)
  check('unknown wake creation has not published signal or opened native '+committed,[(await f.inventory()).signals.length,f.opens.length],[0,0])
  const before=f.commands.filter(x=>x.op==='push').length,originalOperation=f.records.ownedAttempts.get(JSON.stringify([key,'wake'])).id
  if(committed){
   await request();await f.drain();await f.poll()
   const wake=await f.records.get(key)
   check('confirmed original authority attempt reevaluates actual later source attachment',[wake.delivered,wake.request.sources.length,f.records.ownedAttempts.has(JSON.stringify([key,'wake'])),f.opens.length],[true,1,false,1])
   await f.call('dss_snapshot',{},'unknown-create-consume');await f.finish()
   check('original create UNKNOWN then real completion retires wake',await f.records.get(key),undefined)
  }else{
   await request();await f.drain()
   const sameOperation=f.commands.filter(x=>x.op==='push'&&f.g.git(['cat-file','commit',x.commit]).toString().split('\n').includes('DSS-Operation: '+originalOperation))
   check('authority continuation republishes same original operation, not a new command',[sameOperation.length,f.records.ownedAttempts.has(JSON.stringify([key,'wake'])),!!await f.records.get(key)],[2,false,true])
   // The callback's confirmed re-evaluation sees an existing wake (created=false).
   // Its original state publication is resumed by the existing admission check.
   await f.rt.observeWakeAdmissions();await f.drain();await f.poll()
   check('existing admission continuation publishes signal and starts once',[f.opens.length,(await f.records.get(key)).delivered],[1,true])
  }
  await capture('wake-create-unknown-'+committed,f)
 }
 const output={label,checks:checks.length,failures,assertions:checks,results,root,...evidence(),scriptSha256:hash(await fs.readFile(fileURLToPath(import.meta.url))),limits:'Actual production Runtime/HostLoop/registered SDK tools and local Git CLI objects/CAS. Native model/open/send/status/flush/stat controlled. Held H is controlled ordering of actual state read, not fake network performance or user incident. Other member B uses real helper service with separate runtime scope on same Git repo. Actual Task initialization and task-owned note/receipt, not full Task model execution. No historical wake/receipt deletion, no HTTP/Dulwich/GitHub claim.'}
 await fs.writeFile(path.join(dir,label+'-results.json'),JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output,null,2));process.exitCode=failures.length?1:0
}finally{for(const f of [...opened].reverse())await f.close();hooks.deregister();await fs.rm(root,{recursive:true,force:true})}
