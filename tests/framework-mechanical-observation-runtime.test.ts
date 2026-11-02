import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Agents from '@deepseek-ai/dsh-agent'
import JobsLocal from '@deepseek-ai/dsh-jobs-local'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { StoragePort } from '../src/contracts/ports.js'
import { withSnapshot } from '../src/framework/transactions.js'
import { LocalFiles } from '../src/framework/local-files.js'
import { DshSessionReader } from '../src/adapters/dsh/sessions.js'
import type { OwnedDshAgent } from '../src/adapters/dsh/host-types.js'
import { MockAdapter, textResponse, toolCallResponse } from './fixtures/official-mock-adapter.js'

import { initializeTask, paths } from '../src/framework/task-files.js'
import { installFrameworkRoleTools } from '../src/framework/role-tools.js'
import { FrameworkRoleRuntime } from '../src/framework/role-runtime.js'
import type { WorkIdentity } from '../src/framework/recovery.js'

// Real official native execution/Tools/JSONL and runtime reset service. Admission
// metadata is seeded; only model, time and an original-work barrier are controlled.
for (const [role, hold, heldRemote] of [['Organizer', undefined], ['Recorder', undefined], ['Planner', undefined], ['Worker', undefined], ['Helper', undefined], ['Foreground', undefined], ['Organizer', 'paused'], ['Organizer', 'cancelled'], ['Worker', undefined, true]] as const) {
 test(role === 'Foreground' ? 'mechanical native Foreground remains excluded while native work continues' : `mechanical native ${role}${hold ? ' '+hold : ''}${heldRemote ? ' held heartbeat' : ''}: queued probe is not reset; consumed self-tool resets and original work continues`, async t => {
  const root=await mkdtemp(join(tmpdir(),'dss-mechanical-')),ctx=new Context(),files=await LocalFiles.open(join(root,'files'))
  const rows=new Map<string,unknown>(), storage:StoragePort={get:async<T>(key:string)=>rows.get(key) as T|undefined,set:async<T>(key:string,value:T)=>{rows.set(key,value)},list:async<T>(prefix:string)=>[...rows].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value:value as T}))}
  const heartbeatGate=Promise.withResolvers<void>(),heartbeatEntered=Promise.withResolvers<void>();let heartbeatFlights=0,heartbeatCalls=0,maxHeartbeatFlights=0;let remotePoll:Promise<void>|undefined
  const runtime=new FrameworkRoleRuntime(ctx,files,storage,{scope:'mechanical-native',member:'A',primary:true,workspace:root,workerSeats:1,mode:'local',collaborationId:'mechanical'},{members:()=>['A'],resources:()=>[],heartbeat:async()=>{heartbeatCalls++;heartbeatFlights++;maxHeartbeatFlights=Math.max(maxHeartbeatFlights,heartbeatFlights);try { if(heldRemote){heartbeatEntered.resolve();await heartbeatGate.promise} } finally { heartbeatFlights-- }},error:error=>{throw error}})
  const internal=runtime as any,services=internal.services()
  let now=Date.now();(runtime.observations as any).now=()=>now
  const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),afterReset=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>()
  let target:OwnedDshAgent|undefined
  t.after(async()=>{gate.resolve();finish.resolve();const stopped=runtime.loop.stop();heartbeatGate.resolve();await remotePoll;await stopped;await target?.dispose();await runtime.observations.dispose();await ctx.fiber.dispose();await files.close();await rm(root,{recursive:true,force:true})})
  await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjections);await ctx.plugin(SystemPrompt);await ctx.plugin(Tools);await ctx.plugin(Agents);await ctx.plugin(JobsLocal)
  await ctx.plugin(JsonlPersistence,{root:join(root,'sessions'),compression:'none'});await ctx.plugin(AgentDefaultModel,{provider:'controlled',model:'mechanical'});await ctx.plugin(AgentLoop,{agents:[]})
  const sourcePath='tasks/native_'+(role==='Organizer'?'O':'P')+'.md'
  await withSnapshot(files,s=>files.commit(s,[{path:sourcePath,content:'Original authorized task'}],'fixture'))
  const task=await withSnapshot(files,async s=>{const plan=await initializeTask(files,s,sourcePath,'A',[]);await files.commit(s,plan.changes,'fixture');return plan.value})
  const identity:WorkIdentity={role,workId:'native-work',executionId:'native-execution',...(role==='Organizer'||role==='Helper'?{}:{taskId:task.taskId}),...(['Planner','Worker'].includes(role)?{member:'A'}:{}),...(role==='Worker'?{workerId:'child'}:{})}
  const marker=paths.state('A',task.taskId)+'/recovery'
  await withSnapshot(files,s=>files.commit(s,[{path:marker,content:''}],'fixture'))
  const text=(m:any):string=>typeof m.content==='string'?m.content:m.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n')
  let step=0,probeId=''
  const adapter=new MockAdapter(Array.from({length:8},()=>((options:any)=>{
   if(step++===0)return toolCallResponse('original-work','mechanical_work',{})
   if(role==='Foreground')return textResponse('Foreground continues without a mechanical probe.');
   if(step===2){const probe=options.messages.map(text).map((body:string)=>{try{return JSON.parse(body)}catch{return {}}}).find((v:any)=>['probe-role','probe-helper'].includes(v.kind));assert.ok(probe?.probeId,'Actual native input includes probe identity');probeId=probe.probeId;return toolCallResponse('self-reset','dss_reset_observation',{probeId})}
   if(step===3)return toolCallResponse('continue-work','mechanical_continue',{})
   return textResponse('Original work continued after the probe.')
  })))
  ctx.llm.registerAdapter(['controlled'],adapter)
  internal.roleRecords.set(identity.workId,{identity,sessionId:'native-'+role,generation:1,lastWake:{id:'original-wake',role,reason:'notification',sources:[],taskId:task.taskId}})
  target=await runtime.native.open(identity,{sessionId:'native-'+role,cwd:root,setup:(scope,agent)=>{
   for(const [name,execute] of [['mechanical_work',async()=>{entered.resolve();await gate.promise;return {done:true}}],['mechanical_continue',async()=>{afterReset.resolve();await finish.promise;return {done:true}}]] as const)scope.tools.register({name,description:'Controlled original work boundary',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{},render:(_args:any,result:any)=>[{type:'text',text:JSON.stringify(result)}]},execute})
   installFrameworkRoleTools(scope,agent,{...identity,owner:'A'},services)
  }})
  await target.send('Original authorized task','original','followup','deepseek-servant');await entered.promise
  if(heldRemote){remotePoll=runtime.loop.poll();await heartbeatEntered.promise;now=Date.now()+5*60_000;await (runtime.loop as any).drive();await (runtime.loop as any).drive();await (runtime.loop as any).drive();assert.equal(heartbeatCalls,1);assert.equal(maxHeartbeatFlights,1);assert.equal(heartbeatFlights,1)}
  else {await runtime.observations.tick();now=Date.now()+5*60_000;await runtime.observations.tick();await internal.processObservations()}
  const reader=new DshSessionReader(ctx),inputs=await reader.inputs(target.sessionId)
  const probe=[...inputs].find(([,input])=>input.text.includes('"kind":"probe-'))
  if(role==='Foreground'){assert.equal(probe,undefined);assert.equal(await internal.observationStore.get(identity.workId),undefined);await assert.rejects(services.observation.reset({...identity,owner:'A'},{probeId:'not-a-probe'},String(target.actualAgent.id)+':self-reset',new AbortController().signal),/Foreground/);gate.resolve();await target.whenIdle();return}
  assert.ok(probe,'Host delivers real native probe rather than waking another Helper');assert.equal(probe[1].state,'queued');probeId=probe[0]
  const binding={...identity,owner:'A'},signal=new AbortController().signal
  await assert.rejects(services.observation.reset(binding,{probeId},String(target.actualAgent.id)+':self-reset',signal),/actually received/)
  const before=await internal.observationStore.get(identity.workId);assert.equal(before.observation.stage,1);assert.equal(before.resetInputs,undefined)
  if(hold)await runtime.controls.setTask('held-'+hold,task.taskId,hold)
  gate.resolve();await afterReset.promise
  assert.equal((await reader.inputs(target.sessionId)).get(probeId)?.state,'consumed')
  if(hold){const held=await internal.observationStore.get(identity.workId);assert.equal(held.observation.stage,1);assert.equal(held.resetInputs,undefined);await runtime.controls.setTask('resume',task.taskId,'running');await services.observation.reset(binding,{probeId},String(target.actualAgent.id)+':self-reset',signal)}
  if(heldRemote){assert.equal(heartbeatFlights,1,'Consumed native reset completes while remote heartbeat is still held');assert.equal(heartbeatCalls,1)}
  const reset=await internal.observationStore.get(identity.workId);assert.equal(reset.observation.stage,0);assert.ok(reset.resetInputs.includes(probeId))
  await withSnapshot(files,async s=>assert.equal(await files.read(s,marker),''))
  await assert.rejects(services.observation.reset(binding,{probeId},String(target.actualAgent.id)+':fabricated',signal),/original native tool call/)
  await assert.rejects(services.observation.reset({...binding,executionId:'replacement'},{probeId},String(target.actualAgent.id)+':self-reset',signal),/unavailable/)
  now+=1234;await services.observation.reset(binding,{probeId},String(target.actualAgent.id)+':self-reset',signal)
  assert.equal((await internal.observationStore.get(identity.workId)).observation.cycleStartedAt,reset.observation.cycleStartedAt,'Original native tool-call replay cannot restart the timer again')
  now+=5*60_000;await runtime.observations.tick();const later=await internal.observationStore.get(identity.workId);assert.equal(later.observation.stage,1);await services.observation.reset(binding,{probeId},String(target.actualAgent.id)+':self-reset',signal);assert.deepEqual((await internal.observationStore.get(identity.workId)).observation,later.observation,'Old reset replay cannot clear a later probe stage');
  finish.resolve();await target.whenIdle();await ctx.sessions.flush(target.actualAgent.session)
  assert.ok(target.getMessages().some(m=>text(m).includes('Original work continued after the probe.')))
  await runtime.native.stop(identity.workId,identity.executionId)
  await assert.rejects(services.observation.reset(binding,{probeId},String(target.actualAgent.id)+':self-reset',signal),/unavailable/)
 })
}
