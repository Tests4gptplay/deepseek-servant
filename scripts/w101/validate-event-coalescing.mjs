// Supplement 21: actual Runtime native.open setup -> installed SDK Session event
// bus/tool registry -> tracker -> conversation -> transaction -> real Git objects.
// Native Agent/model, transport fault, and connection-loss boundaries are explicit.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import {AsyncLocalStorage} from 'node:async_hooks'
const selected=path.resolve(fileURLToPath(new URL('../..',import.meta.url))),label='candidate'
const candidate=true
const {hash,evidence,hooks,sdkHostRoot}=await import(pathToFileURL(selected+'/scripts/test-support/dsh-sdk-runtime.mjs'))
const {openDshStorageFixture}=await import(pathToFileURL(selected+'/scripts/test-support/dsh-sdk-storage.mjs'))
const require=createRequire(path.join(sdkHostRoot,'s21-process-audit.mjs'))
const pkg=async name=>import(pathToFileURL(require.resolve(name)))
const {Context}=await pkg('@deepseek-ai/cordis'),{Session}=await pkg('@deepseek-ai/dsh-session')
const {SystemPrompt}=await pkg('@deepseek-ai/dsh-system-prompt'),{ToolRuntime}=await pkg('@deepseek-ai/dsh-tools'),{createScope}=await pkg('@deepseek-ai/dsh-scope')
const {gitFixture}=await import('./real-git-cli-fixture.mjs'),src=pathToFileURL(selected+'/src/')
const {FrameworkRoleRuntime}=await import(new URL('framework/role-runtime.ts',src))
const {GitAuthorityStore}=await import(new URL('framework/git-authority.ts',src))
const {PhysicalLocalFiles}=await import(new URL('framework/physical-local-files.ts',src))
const {DshForegroundProcessTracker}=await import(new URL('adapters/dsh/foreground-process.ts',src))
const {withSnapshot,FilesOutcomeUnknownError}=await import(new URL('framework/transactions.ts',src))
const {GitBackendError}=await import(new URL('experimental/private-git/git-object-backend.ts',src))
const root=await fs.mkdtemp(path.join(os.tmpdir(),'dss-w101-')),dir=root
const checks=[],results=[],opened=[],trace=new AsyncLocalStorage()
const check=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);checks.push({name,actual});console.error('CHECK '+checks.length+': '+name)}
const failure=async(name,action,re)=>{let error;try{await action()}catch(e){error=e}assert.match(String(error),re,name);checks.push({name,error:String(error)});console.error('CHECK '+checks.length+': '+name);return error}
const at=(time,action)=>{const old=Date.now;Date.now=()=>Date.parse(time);try{return action()}finally{Date.now=old}}
const day1='2026-11-10T23:59:59.000Z',day2='2026-11-11T00:00:01.000Z'
const json=x=>JSON.stringify(x)+'\n'
async function fixture(name,mode='git',prior){
 const directory=path.join(root,name);await fs.mkdir(directory)
 const state={loseAck:false,unavailable:false,commitBeforeFailure:true,failBeforePush:false,barrier:undefined},commands=[],errors=[],logs=[],saves=[],handles=new Map(),scopes=[],sessions=new Map()
 let g
 if(mode==='git')g=gitFixture(prior?.objects??path.join(directory,'objects.git'),'sha1',async command=>{
   commands.push({...command,stage:trace.getStore()})
   if(state.failMetadata&&trace.getStore()==='process-metadata'&&command.op==='writeBlob'){state.failMetadata=false;throw new GitBackendError('transport','Controlled metadata pre-push failure')}
   if(state.failBeforePush&&command.op==='writeBlob'){state.failBeforePush=false;throw new GitBackendError('transport','Controlled metadata pre-push failure')}
   if(state.barrier&&command.op==='push'){const b=state.barrier;if(++b.arrivals===2)b.release();if(b.arrivals<=2)await b.promise}
   if(state.unavailable&&command.op==='fetchHead')throw new GitBackendError('transport','Controlled original resolution unavailable')
   if(state.loseAck&&command.op==='push'){
     state.loseAck=false;if(state.commitBeforeFailure)g.git(['update-ref',command.ref,command.commit,command.expected]);state.unavailable=true
     throw new GitBackendError('transport','Controlled lost acknowledgement at actual Git CAS boundary')
   }
 },!!prior)
 const sdk=mode==='local'?await openDshStorageFixture(path.join(directory,'sdk'),path.join(directory,'locator')):undefined
 const files=g?.files??new PhysicalLocalFiles(path.join(directory,'files'))
 const records=g?new GitAuthorityStore(files,'s21-process'):sdk.adapter,shared=g?new GitAuthorityStore(files,'shared'):records
 const ctx=new Context();new SystemPrompt(ctx,{});new ToolRuntime(ctx)
 ctx.provide('agents',{get:id=>[...handles.values()].find(h=>h.sessionId===id)?.actualAgent})
 ctx.provide('sessions',{get:id=>sessions.get(id),flush:async()=>{}});ctx.provide('jobs',{list:()=>[]})
 ctx.logger.exporter({export:message=>logs.push({name:message.name,type:message.type,args:message.args.map(arg=>arg instanceof Error?{name:arg.name,message:arg.message}:arg)})})
 const config={scope:'process',mode,member:'A',primary:true,collaborationId:'process-chat',workerSeats:1,workspace:directory,instanceUUID:'11111111-1111-4111-8111-111111111111'}
 const rt=new FrameworkRoleRuntime(ctx,files,records,config,{sharedRecords:shared,members:()=>['A'],resources:()=>[],error:(e,origin)=>{errors.push({error:String(e),origin});if(state.errorSinkThrows)throw Error('Controlled reporting sink failure');return true}})
 const save=rt.conversation.saveProcessGroups.bind(rt.conversation)
 rt.conversation.saveProcessGroups=(...args)=>{saves.push(structuredClone(args));return trace.run('process-metadata',()=>save(...args))}
 rt.gateway.exists=async()=>false
 rt.native.get=(key,id)=>{const h=handles.get(key);return !id||h?.identity.executionId===id?h:undefined}
 rt.native.open=async(identity,options)=>{
   const session=new Session(options.sessionId),agent={id:options.sessionId,session,status:'running'}
   const scope=createScope(ctx,agent);scopes.push(scope);options.setup(scope.ctx,agent)
   sessions.set(options.sessionId,session)
   const received=new Set(),owned={identity,sessionId:options.sessionId,actualAgent:agent,observe:()=>({state:agent.status}),hasMessage:id=>received.has(id),send:async(_text,id)=>{received.add(id)}}
   handles.set(identity.workId,owned);return owned
 }
 const owner=()=>rt.roleRecords.get(rt.roleKey('Foreground'))
 const owned=()=>owner()?rt.native.get(owner().identity.workId):undefined
 const add=(type,data,time=day1,extra={})=>{const session=owned().actualAgent.session;at(time,()=>session.append(type,data,extra));const event=session.snapshotEvents().at(-1);ctx.emit('session/event',session,event);return event}
 const admit=async()=>{
   const request={id:name+'-foreground',role:'Foreground',reason:'notification',sources:[]}
   assert.equal(await rt.wake(request),true);await rt.runQueue(false,request.id)
   assert.equal(errors.length,0,JSON.stringify(errors));assert(owner());assert(owned())
   add('turn/start',{turn:1});add('step/start',{turn:1,step:0});return owner()
 }
 const assistant=(step=0,time=day1)=>add('assistant/message',{turn:1,step,stream:[],message:{id:'assistant-'+step,role:'assistant',source:{kind:'model',provider:'controlled',model:'fixture'},content:[{type:'reasoning',text:'thinking'}, {type:'text',text:'native response is display only'}]}},time,{surfaceOp:'append'})
 const call=async(callId,input,time=day1)=>{
   add('tool/call',{turn:1,step:1,callId,name:'dss_conversation_send',arguments:JSON.stringify(input)},time)
   const result=await ctx.tools.execute({name:'dss_conversation_send',arguments:input,agent:owned().actualAgent,callId,signal:new AbortController().signal})
   if(result.isError)throw Error(JSON.stringify(result));return result.value
 }
 const resultEvent=(callId,value)=>add('tool/result',{turn:1,step:1,message:{id:'result-'+callId,role:'tool',source:{kind:'tool',callId},toolCallId:callId,content:[{type:'text',text:JSON.stringify(value)}]}},day1,{surfaceOp:'append'})
 const flush=()=>rt.flushForegroundProcessWrites(owner().sessionId)
 const inventory=()=>withSnapshot(files,async snapshot=>({revision:snapshot.revision,
   receipts:await Promise.all((await files.list(snapshot,'technical/command-receipts/')).map(async entry=>({path:entry.path,value:JSON.parse(await files.read(snapshot,entry.path))}))),
   daily:mode==='git'?await Promise.all((await files.listDirectory(snapshot,'conversations/git/process-chat/')).map(async entry=>({path:entry.path,value:JSON.parse(await files.read(snapshot,entry.path))}))):[{path:rt.conversation.indexPath,value:JSON.parse(await files.read(snapshot,rt.conversation.indexPath))}]}))
 const handoff=()=>({objects:prior?.objects??path.join(directory,'objects.git'),events:owned().actualAgent.session.snapshotEvents(),header:owned().actualAgent.session.header,record:owner(),args:saves.at(-1)})
 const close=async()=>{rt.closed=true;for(const scope of scopes)await scope.dispose();await rt.foregroundActivity.dispose();await rt.observations.dispose();await rt.transactions.closeGitSession(Error('Controlled connection close'));await records.close();if(shared!==records)await shared.close();if(g)await g.repo.releaseCache();else await files.close();await sdk?.close();opened.splice(opened.indexOf(f),1)}
 const f={g,files,records,rt,ctx,state,commands,errors,logs,saves,owner,owned,admit,add,assistant,call,resultEvent,flush,inventory,handoff,close,directory};opened.push(f);return f
}
const processReceipts=s=>s.receipts.filter(r=>r.value.id.startsWith('conversation/git/process-chat/process/'))
const groups=s=>s.daily.flatMap(d=>d.value.processGroups??[])
const pushes=f=>f.commands.filter(c=>c.op==='push').length
const capture=async(name,f)=>results.push({name,inventory:await f.inventory(),saves:f.saves,commands:f.commands,errors:f.errors,logs:f.logs,events:f.owned()?.actualAgent.session.snapshotEvents()})
try {
{
 const f=await fixture('event-burst'); await f.admit(); f.assistant(); await f.flush()
 const initialSaves=f.saves.length, initialCommands=f.commands.length
 for(let i=0;i<5;i++){
  const id='normal-tool-'+i
  f.add('tool/call',{turn:1,step:1,callId:id,name:'dss_read',arguments:'{}'})
  f.resultEvent(id,{text:'actual tool result '+i})
 }
 await f.flush()
 const commands=f.commands.slice(initialCommands).filter(c=>c.stage==='process-metadata')
 const output={savesAfterBurst:f.saves.length-initialSaves,savedPayloads:f.saves.slice(initialSaves).map(x=>x[1]),operations:commands.reduce((a,c)=>(a[c.op]=(a[c.op]??0)+1,a),{}),groupCount:groups(await f.inventory()).length,errors:f.errors,limits:'Actual installed SDK Session events, Runtime event callback, tracker, conversation and local Git CLI CAS. Five normal sequential call/results injected as controlled event burst; no model, DSH UI, remote HTTP, or real-user frequency/performance claim.',source:selected}
 assert.equal(output.savesAfterBurst,1);assert.deepEqual(output.operations,{fetchHead:1,readObject:1});assert.equal(output.groupCount,1);console.log(JSON.stringify(output,null,2))

}
{
 const f=await fixture('failure-retry');await f.admit();f.assistant();await f.flush()
 const original=f.rt.conversation.saveProcessGroups.bind(f.rt.conversation);let enter,release,attempts=0
 const arrived=new Promise(r=>enter=r),gate=new Promise(r=>release=r)
 f.rt.conversation.saveProcessGroups=async(...args)=>{attempts++;if(attempts===1){enter();await gate;throw Error('Controlled first metadata save failure')}return original(...args)}
 f.assistant(1);await arrived
 for(let i=0;i<3;i++){const id='retry-tool-'+i;f.add('tool/call',{turn:1,step:2,callId:id,name:'dss_read',arguments:'{}'});f.resultEvent(id,{text:'tool '+i})}
 const queued=f.rt.foregroundProcessWrites.size;release()
 for(let i=0;i<200;i++)await new Promise(setImmediate);const beforeFlush=attempts;await f.flush()
 const output={beforeFlush,attempts,queued,groupCount:groups(await f.inventory()).length,errors:f.errors.map(e=>e.message??String(e)),pending:f.rt.foregroundProcessWrites.size,limits:'Actual SDK event callback and production tracker/Git CLI; first metadata failure and hold are controlled ports, no user incident or live model.'}
 assert.equal(beforeFlush,2);assert.equal(attempts,2);assert.equal(queued,1);assert.equal(output.pending,0);assert(output.groupCount>=1);console.log(JSON.stringify(output,null,2))

}
{
 const f=await fixture('two-failures');await f.admit();f.assistant();await f.flush()
 const original=f.rt.conversation.saveProcessGroups.bind(f.rt.conversation);let enter,release,attempts=0
 const arrived=new Promise(r=>enter=r),gate=new Promise(r=>release=r)
 f.rt.conversation.saveProcessGroups=async(...args)=>{attempts++;if(attempts===1){enter();await gate;throw Error('Controlled first metadata save failure')}if(attempts===2)throw Error('Controlled second metadata save failure');return original(...args)}
 f.assistant(1);await arrived
 for(let i=0;i<3;i++){const id='retry-tool-'+i;f.add('tool/call',{turn:1,step:2,callId:id,name:'dss_read',arguments:'{}'});f.resultEvent(id,{text:'tool '+i})}
 const queued=f.rt.foregroundProcessWrites.size;release()
 for(let i=0;i<200;i++)await new Promise(setImmediate);const beforeFlush=attempts;await f.flush()
 const output={beforeFlush,attempts,queued,groupCount:groups(await f.inventory()).length,errors:f.errors.map(e=>e.message??String(e)),pending:f.rt.foregroundProcessWrites.size,limits:'Actual SDK event callback and production tracker/Git CLI; first metadata failure and hold are controlled ports, no user incident or live model.'}
 assert.equal(beforeFlush,3);assert.equal(attempts,3);assert.equal(queued,1);assert.equal(output.pending,0);assert(output.groupCount>=1);console.log(JSON.stringify(output,null,2))

}
{
 const f=await fixture('different-snapshots');await f.admit();f.assistant();await f.flush()
 const original=f.rt.conversation.saveProcessGroups.bind(f.rt.conversation);let enter,release,attempts=0
 const arrived=new Promise(r=>enter=r),gate=new Promise(r=>release=r)
 f.rt.conversation.saveProcessGroups=async(...args)=>{attempts++;if(attempts===1){enter();await gate}return original(...args)}
 f.assistant(1);await arrived;f.assistant(2)
 const id='same-snapshot-tool';f.add('tool/call',{turn:1,step:3,callId:id,name:'dss_read',arguments:'{}'});f.resultEvent(id,{text:'tool'})
 release();await f.flush()
 const output={attempts,groups:groups(await f.inventory()).map(g=>g.id),pending:f.rt.foregroundProcessWrites.size,errors:f.errors,limits:'Actual SDK callbacks and Git CLI; controlled in-flight save, no real model/network.'}
 assert.equal(attempts,2);assert.equal(output.pending,0);assert.equal(output.groups.length,3);console.log(JSON.stringify(output,null,2))

}
console.error('W101 actual event scenarios: 4 passed')
} finally {for(const f of [...opened].reverse())await f.close();hooks.deregister();await fs.rm(root,{recursive:true,force:true})}
