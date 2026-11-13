import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { rmSync } from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {evidence} from './test-support/dsh-sdk-runtime.mjs'
import {openDshStorageFixture} from './test-support/dsh-sdk-storage.mjs'
const {AgentRegistry}=await import('@deepseek-ai/dsh-agent'),{SessionStore}=await import('@deepseek-ai/dsh-session'),{SessionProjectionRegistry}=await import('@deepseek-ai/dsh-session-projection')
const {LlmRuntime,LlmAdapter}=await import('@deepseek-ai/dsh-llm'),{ToolRuntime}=await import('@deepseek-ai/dsh-tools'),{SystemPrompt}=await import('@deepseek-ai/dsh-system-prompt'),{AgentLoop}=await import('@deepseek-ai/dsh-agent-loop')
const {LocalJobRegistry}=await import('@deepseek-ai/dsh-jobs-local'),{WorkspaceRegistry}=await import('@deepseek-ai/dsh-workspace'),{LocalFileSystem}=await import('@deepseek-ai/dsh-fs-local'),{WorkingDirectoryService}=await import('@deepseek-ai/dsh-working-directory')
const jsonl=await import('@deepseek-ai/dsh-session-persistence-jsonl'),cleaner=await import('../src/native-cleaner/plugin.mjs')
const {RetirementStore}=await import('../src/native-cleaner/retirement-store.mjs'),{NativeCleanerCoordinator}=await import('../src/native-cleaner/coordinator.mjs'),{ExactJsonlAdapter,sessionDirectory}=await import('../src/native-cleaner/jsonl-adapter.mjs')
const originalSessionGet=SessionStore.prototype.get
SessionStore.prototype.get=function(id){const value=originalSessionGet.call(this,id),caller=new Error().stack;if(caller.includes('/framework/role-runtime.ts:'))mark('recovery-header-get',{id,present:!!value,cwd:value?.header.cwd,caller});return value}
const {DshStorageAdapter}=await import('../src/adapters/dsh/storage.ts')
const storageSet=DshStorageAdapter.prototype.set
DshStorageAdapter.prototype.set=async function(key,value){const r=await storageSet.call(this,key,value);if(value?.identity?.role)mark('role-persisted',{key,record:value});return r}
const {FrameworkService}=await import('../src/framework/service.ts')
const root=process.env.DSS_PO_NATIVE_ROOT??await fs.mkdtemp('/tmp/dss-helper-native-')
if (!process.env.DSS_PO_NATIVE_ROOT) process.once('exit', () => rmSync(root, { recursive: true, force: true }))
await fs.mkdir(root,{recursive:true});const trace=[],checks=[],results=new Map()
const hash=x=>createHash('sha256').update(x).digest('hex'),defer=()=>Promise.withResolvers(),mark=(event,data={})=>{trace.push({event,...data});console.log(event,JSON.stringify(data))}
const check=(name,a,b)=>{assert.deepEqual(a,b,name);checks.push(name)}
async function until(name,fn){const end=Date.now()+20000;while(true){const r=await fn();if(r)return r;if(Date.now()>end)throw Error('Experiment wait expired: '+name);await new Promise(r=>setTimeout(r,10))}}
const accept=RetirementStore.prototype.accept,cleanup=ExactJsonlAdapter.prototype.cleanup,retire=NativeCleanerCoordinator.prototype.retire
NativeCleanerCoordinator.prototype.retire=function(id){mark('retire',{id});return retire.call(this,id)}
RetirementStore.prototype.accept=async function(lives,verify){for(const l of lives)mark('accept-attempt',{id:l.id});const r=await accept.call(this,lives,verify);for(const l of lives)mark('accepted',{id:l.id});return r}
ExactJsonlAdapter.prototype.cleanup=async function(life){mark('physical',{id:life.id});return cleanup.call(this,life)}
function tool(name,input,id,index=0){return [{type:'tool-call-delta',index,name,id,argumentsDelta:JSON.stringify(input)},{type:'finish',reason:'tool-calls'}]}
class Model extends LlmAdapter{
 calls=[];claimed=new Set();waiting=new Map()
 async *stream(o){this.calls.push(o);mark('model',{id:o.sessionId,call:this.calls.length});const supports=n=>o.tools.some(t=>t.name===n)
  if(process.env.DSS_EARLY_UPGRADE_TOOL==='1'&&supports('dss_upgrade_local_files')&&!this.earlyUpgradeCalled){this.earlyUpgradeCalled=true;yield*tool('dss_upgrade_local_files',{action:'restore_conversation',collaborationId:'po-native'},'early-restore');return}
  if(supports('dss_task_restore')&&!this.claimed.has(o.sessionId)){this.claimed.add(o.sessionId);yield*tool('dss_claim',{},'foreground-claim-'+this.calls.length);return}
  if(this.nextForeground&&supports('dss_task_restore')){const p=this.nextForeground;this.nextForeground=undefined;yield*tool(p.name,p.input,'foreground-request-'+this.calls.length);return}
  if(supports('dss_task_restore')){yield{type:'text-delta',index:0,text:'Request arranged.'};yield{type:'finish',reason:'stop'};return}
  if(!this.claimed.has(o.sessionId)&&supports('dss_restore')){this.claimed.add(o.sessionId);yield*tool('dss_claim',{},'claim-'+this.calls.length);return}
  yield{type:'text-delta',index:0,text:'Actual isolated model progress.'}
  const d=defer();this.waiting.set(o.sessionId,d)
  const abort=()=>d.reject(o.signal.reason);o.signal.addEventListener('abort',abort,{once:true});if(o.signal.aborted)abort()
  let action;try{action=await d.promise}finally{o.signal.removeEventListener('abort',abort);this.waiting.delete(o.sessionId)}
  if(action==='idle'){yield{type:'finish',reason:'stop'};return}
  if(typeof action==='object'){yield*tool(action.name,action.input,action.callId??'controlled-'+this.calls.length,1);return}
  throw new Error('Unexpected controlled model action')
 }
 command(id,action){const d=this.waiting.get(id);assert(d,'Actual model must be waiting');d.resolve(action)}
}
async function fixture(name='fixture',reopen=false,disabledOrBeforeStart=false){const dir=path.join(root,name);await fs.mkdir(path.join(dir,'workspace'),{recursive:true});if(typeof disabledOrBeforeStart==='function')await disabledOrBeforeStart(dir);const disabled=disabledOrBeforeStart===true;const sdk=await openDshStorageFixture(path.join(dir,'storage'),path.join(dir,'locator'))
 new AgentRegistry(sdk.ctx);new SessionStore(sdk.ctx);new SessionProjectionRegistry(sdk.ctx);new LlmRuntime(sdk.ctx);new SystemPrompt(sdk.ctx,{});new ToolRuntime(sdk.ctx);new LocalJobRegistry(sdk.ctx,{})
 const jp=sdk.ctx.plugin(jsonl,{root:path.join(dir,'sessions'),compression:'none'});await jp.await()
 new LocalFileSystem(sdk.ctx,{cwd:path.join(dir,'workspace'),diffBasisMaxBytes:1048576});new WorkingDirectoryService(sdk.ctx,{defaultDirectory:path.join(dir,'workspace')});const wp=sdk.ctx.plugin(WorkspaceRegistry);await wp.await();const lp=sdk.ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:10});await lp.await()
 const model=new Model();sdk.ctx.llm.registerAdapter(['isolated-wire'],model)
 sdk.ctx.on('session/event',(session,event)=>{if(['tool/call','tool/result'].includes(event.type)){mark('tool',{id:session.header.id,type:event.type,data:event.data});if(event.type==='tool/result'&&!event.data.message.isError){for(const c of event.data.message.content??[])if(c.type==='text'){try{const v=JSON.parse(c.text);if(v.snapshotId)results.set(session.header.id,v)}catch{}}}}})
 await cleaner.apply(sdk.ctx,{}, {onFailure(e,stage){throw Error(stage,{cause:e})}})
 const rawOpen=sdk.ctx.sessionPersistence.open.bind(sdk.ctx.sessionPersistence)
 sdk.ctx.sessionPersistence.open=async function(id,mode){mark('native-open',{id,mode,caller:new Error().stack});const h=await rawOpen(id,mode),close=h.close.bind(h);h.close=async()=>{const r=await close();mark('native-handle-closed',{id,mode});return r};return h}
 const service=new FrameworkService(sdk.ctx,sdk.adapter,{name:'PO native evidence',userName:'Evidence',localDirectory:path.join(dir,'business'),ownerRepo:'',repositoryDirectory:path.join(dir,'unused-git'),collaborationId:'po-native',workerSeats:1,workspace:path.join(dir,'workspace'),foreground:{provider:'isolated-wire',model:'controlled'},background:{provider:'isolated-wire',model:'controlled'}})
 if(disabled)await sdk.adapter.set('framework-participation/local',false)
 await service.start();const active=service.running.get('local');if(!disabled)assert(active,'Actual Service startup');const rt=active?.runtime,prefix='framework-runtime/'+hash(active?.connection.scope??'')+'/'
 const f={dir,sdk,jp,model,service,active,rt,prefix,closed:false,
  row:r=>active.connection.records.get(prefix+'roles/'+hash(r.identity.workId)),
  file:r=>path.join(sessionDirectory(path.join(dir,'sessions'),{...sdk.ctx.sessions.get(r.sessionId)?.header,id:r.sessionId}), 'session.v4.jsonl'),
  async close(){if(f.closed)return;f.closed=true;await service.dispose();await Promise.allSettled(rt?.nativeRetirementOperations?.values()??[]);await sdk.ctx.get('nativeSessionCleaner').drain();await jp.dispose();await sdk.close()}}
 mark('fixture',{dir,reopen,scope:active?.connection.scope,disabled});return f
}
async function missing(file){return fs.access(file).then(()=>false,e=>{if(e.code==='ENOENT')return true;throw e})}

export {fixture,trace,checks,mark,check,until,hash,results,missing,root,evidence}
