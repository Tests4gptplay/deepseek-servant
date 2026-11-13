// Unchanged production entry points, real Git objects/CAS and pinned SDK.
// Controlled transport/native ports, not a live DSH or a user network incident.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {AsyncLocalStorage} from 'node:async_hooks'
import {evidence,hash,hooks} from '../test-support/dsh-sdk-runtime.mjs'
import {openDshStorageFixture} from '../test-support/dsh-sdk-storage.mjs'
import {gitFixture} from './real-git-cli-fixture.mjs'
const src=new URL('../../src/',import.meta.url)
const {FrameworkRoleRuntime}=await import(new URL('framework/role-runtime.ts',src))
const {FrameworkService}=await import(new URL('framework/service.ts',src))
const {GitAuthorityStore}=await import(new URL('framework/git-authority.ts',src))
const {withSnapshot,withOperationChannel}=await import(new URL('framework/transactions.ts',src))
const {initializeTask,paths,readJson}=await import(new URL('framework/task-files.ts',src))
const root=await fs.mkdtemp(path.join(tmpdir(),'dss-w129-')),dir=root
process.once('exit',()=>rmSync(root,{recursive:true,force:true}))
const checks=[],results=[],trace=new AsyncLocalStorage()
const check=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);checks.push({name,actual});console.error('CHECK '+checks.length+': '+name)}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
// Bounded event-loop turns detect a broken test, not simulated network latency.
const until=async(predicate,label)=>{for(let n=0;n<2000;n++){if(predicate())return;await new Promise(setImmediate)}throw Error('Test boundary not reached: '+label)}

async function fixture(name){
 const directory=path.join(root,name);await fs.mkdir(directory)
 let now=100_000,block,checkCalls=0
 const traceEvents=[],logs=[],errors=[],opens=[],sends=[],nativeGates=new Map(),owned=new Map()
 const g=gitFixture(path.join(directory,'objects.git'),'sha1',async(command)=>{
   traceEvents.push({stage:trace.getStore(),command,clock:now})
   if(block&&!block.entered&&trace.getStore()==='checker'&&command.op==='fetchHead'&&command.channel===block.channel){
     block.entered=true;block.command=command;block.arrived.resolve();await block.release.promise
   }
 })
 const sdk=await openDshStorageFixture(path.join(directory,'sdk'),path.join(directory,'locator'))
 const ctx={on:()=>()=>{},get:()=>undefined,agents:{get:()=>undefined},jobs:{list:()=>[]},logger:()=>({error:e=>logs.push(String(e)),warn:e=>logs.push(String(e))})}
 const records=new GitAuthorityStore(g.files,'w129-instance'),shared=new GitAuthorityStore(g.files,'shared')
 const config={scope:'w129-'+name,mode:'git',member:'A',primary:false,instanceUUID:'11111111-1111-4111-8111-111111111111',collaborationId:'w129',workerSeats:1,workspace:directory}
 const service=new FrameworkService(ctx,sdk.adapter,{})
 const rt=new FrameworkRoleRuntime(ctx,g.files,records,config,{sharedRecords:shared,members:()=>['A'],resources:()=>[],
   ...service.safetyCallbacks('git'),error:(error,origin,safety)=>{errors.push({message:String(error),origin});service.report('git',error,config.scope,undefined,origin,safety);return true}})
 const connection={scope:config.scope,files:g.files,records,sharedRecords:shared,registration:{member:'A'},identity:{instanceUUID:config.instanceUUID},transactions:rt.transactions}
 const access={connection,commandHostKey:'controlled-host'}
 service.running.set('git',{connection,runtime:rt,resources:[],workspaceSelection:directory})
 // Authorized UI access resolution is the fixture port. The actual Service
 // taskControl, distinct access.controls, publication and Runtime handoff run.
 service.withAccessOperation=async(input,work)=>{if(input.mode!=='git'||input.storageScope!==config.scope)throw Error('Wrong fixture scope');return work(access)}
 const userControl=(commandId,request,intent)=>service.taskControl({mode:'git',storageScope:config.scope,commandId,taskId:request.taskId,lifecycleId:request.lifecycleId,intent})
 rt.admissionNow=()=>now
 const originalCheck=rt.observeWakeAdmissions.bind(rt)
 rt.observeWakeAdmissions=round=>{checkCalls++;return trace.run('checker',()=>originalCheck(round))}
 // Explicit native Agent port. We do not execute setup, a model, or claim
 // native persistence. Runtime queue, role records and confirmations are real.
 rt.gateway.exists=async()=>false
 rt.native.get=(key,id)=>{const value=owned.get(key);return !id||value?.identity.executionId===id?value:undefined}
 rt.native.open=async(identity,options)=>{
   opens.push({...identity,clock:now});const gate=nativeGates.get(identity.workId)
   if(gate){gate.arrived.resolve();await gate.release.promise}
   const received=new Set(),port={identity,sessionId:options.sessionId,actualAgent:{session:{id:options.sessionId},status:'running'},
     observe:()=>({state:'running'}),hasMessage:id=>received.has(id),
     send:async(text,id,...rest)=>{received.add(id);sends.push({identity,text,id,rest,clock:now})}}
   owned.set(identity.workId,port);return port
 }
 const key=request=>rt.prefix+'wakes/'+hash(request.id)
 const publish=changes=>withOperationChannel(g.files,'foreground-write',()=>withSnapshot(g.files,s=>g.files.commit(s,changes,'W129 controlled real Git input')))
 let taskIndex=0
 const task=async(route='P')=>{const id='20000000-0000-4000-8000-'+String(++taskIndex).padStart(12,'0'),source='tasks/request-'+taskIndex+'_'+route+'.md';
   await publish([{path:source,content:'Actual fixture requirement '+taskIndex+'\n'}])
   const plan=await withSnapshot(g.files,s=>initializeTask(g.files,s,source,'A',['A'],id));await publish(plan.changes)
   return withSnapshot(g.files,s=>readJson(g.files,s,paths.task(id)))
 }
 const wake=async(t,role='Planner',workerId)=>{const request={id:name+'-'+role+'-'+t.taskId+(workerId??''),role,taskId:t.taskId,lifecycleId:t.lifecycleId,workerId,reason:'notification',sources:[]};
   check(name+' creates '+request.id,await rt.wake(request),true);return request}
 const pendingOpen=request=>{const gate={arrived:deferred(),release:deferred()};nativeGates.set(rt.requestKey(request),gate);return gate}
 const observe=async()=>{const round=g.files.readRound('host-poll');await rt.loop.actions.observeLocal(round);return round}
 const drainMaintenance=async()=>{while(rt.maintenance?.size)await Promise.all([...rt.maintenance.values()]);await new Promise(setImmediate)}
 const drainSafety=async()=>{await until(()=>service.safetyDeliveries.size===0,'Service safety dispatch');await drainMaintenance()}
 const close=async()=>{rt.closed=true;for(const gate of nativeGates.values())gate.release.resolve();block?.release.resolve();
   await Promise.all([...rt.admissions?.values()??[]]);await drainMaintenance();await rt.transactions.closeGitSession();await records.close();await shared.close();await g.repo.releaseCache();await sdk.close()}
 return{g,rt,service,records,config,userControl,access,errors,opens,sends,logs,traceEvents,task,wake,key,publish,pendingOpen,observe,drainMaintenance,drainSafety,close,
   get calls(){return checkCalls},get clock(){return now},set clock(value){now=value},
   hold(channel){block={channel,entered:false,arrived:deferred(),release:deferred()};return block}}
}

export {fixture,check,checks,results,trace,until,deferred,root,dir,evidence,hash,fs,path,withSnapshot,withOperationChannel}
