import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as tick } from 'node:timers/promises'
import { fixture, childSpec } from './task-fixture.ts'
import { RuntimeCoordinator } from '../src/runtime/coordinator.ts'
import { AgentSupervisor } from '../src/runtime/agent-supervisor.ts'
import { Scheduler } from '../src/runtime/scheduler.ts'
import { DshSessionReader } from '../src/adapters/dsh/sessions.ts'

const emptyInspection = () => ({exists:false, liveAgent:false, liveSession:false, liveJobIds:[], eventCount:0, lifecycleKnown:true, queuedInbox:{nextTurn:[],nextStep:[]}, unresolvedToolCallIds:[],jobs:[]})
async function flush(f:any) { for(let i=0;i<8;i++) { await tick(); await f.tasks.flush() } }
async function planned() {
 const f=await fixture(), p=await f.bind('plan');
 assert.equal((await f.execute({type:'planning.commit',expectedGoalRevision:1,expectedPlanRevision:0,strategy:'test',children:[childSpec()]},p.source)).status,'applied');
 await f.execute({type:'execution.observed',executionId:p.execution.executionId,physicalState:'stopped',ownedJobIds:[]});
 return {...f,p};
}
async function delivery() {
 const f=await planned(), w=await f.bind('dispatch','a');
 await f.execute({type:'execution.report',report:{resultId:'r',assignmentVersion:1,outcome:'complete',summary:'saved',artifacts:[],evidence:['synthetic artifact verified'],frontier:'review'}},w.source);
 await f.execute({type:'execution.observed',executionId:w.execution.executionId,physicalState:'stopped',ownedJobIds:[]});
 const p2=await f.bind('evaluate');
 assert.equal((await f.execute({type:'planning.decide',expectedGoalRevision:1,summary:'accept',decisions:[{childId:'a',resultId:'r',outcome:'accept',reason:'verified'}],deliver:{id:'d',summary:'finished',artifacts:[]}},p2.source)).status,'applied');
 await f.execute({type:'execution.observed',executionId:p2.execution.executionId,physicalState:'stopped',ownedJobIds:[]});
 return f;
}

test('ordinary task resume repairs a temporary idempotent delivery failure without an extra configuration handshake',async t=>{
 const f=await delivery(), errors:any[]=[], sent:string[]=[]; let calls=0;
 const original=f.tasks.prepareDelivery.bind(f.tasks);
 f.tasks.prepareDelivery=async id=>{calls++;if(calls===1)throw Object.assign(new Error('temporary file occupied'),{code:'EBUSY'});return original(id)};
 const coordinator=new RuntimeCoordinator({tasks:f.tasks,assistants:{deliver:async()=>{sent.push('notice');return 'notice'}} as any,knowledge:{listSkills:async()=>[]} as any,
 supervisor:{get:()=>undefined,live:()=>new Map()} as any,sessions:{inspect:async()=>emptyInspection(),probeOwnership:async()=> 'absent'} as any,onError:e=>errors.push(e)});
 t.after(()=>coordinator.dispose()); await coordinator.start(); await flush(f);
 let task=await f.get(); const d=Object.values(task.pendingActions).find(a=>a.kind==='deliver')!;
 assert.equal(d.status,'uncertain'); assert.equal(calls,1); assert.equal(task.delivery?.status,'pending');
 coordinator.wake(); await flush(f); assert.equal(calls,1);
 await f.execute({type:'task.control',intent:'resume'},{kind:'user',id:'owner'}); await flush(f);

 task=await f.get(); assert.equal(task.delivery?.status,'delivered'); assert.equal(calls,2); assert.equal(sent.length,1);
 assert.equal(errors.length,1);
});

test('native exact-owner settlement wakes cold recovery without scanning unrelated Tasks',async t=>{
 const f=await planned(), w=await f.bind('dispatch','a'), errors:any[]=[]; let busy=true, probes=0, launches=0; const callbacks=new Map<string,()=>void>(), live=new Map();
 const supervisor={get:(id:string)=>live.get(id),live:()=>live,start:async(task:any,action:any)=>{
  launches++;const id='successor-'+launches;
  const receipt=await f.execute({type:'execution.bind',actionId:action.id,executionId:id,agentId:id,sessionId:id,role:'worker'});assert.equal(receipt.status,'applied');
  live.set(id,{state:'running',ownedJobIds:[]});
 }};
 const coordinator=new RuntimeCoordinator({tasks:f.tasks,assistants:{} as any,knowledge:{} as any,supervisor:supervisor as any,
 sessions:{inspect:async()=>({...emptyInspection(),exists:true,liveJobIds:busy?['live-job']:[]}),probeOwnership:async()=>{probes++;return busy?'busy':'exclusive'},
  watchOwnership:(sessionId:string,fn:()=>void)=>{callbacks.set(sessionId,fn);return()=>callbacks.delete(sessionId)}} as any,onError:e=>errors.push(e)});
 t.after(()=>coordinator.dispose());await coordinator.start();await flush(f);
 let task=await f.get();assert.equal(task.executions[w.execution.executionId].physicalState,'unknown');assert.equal(launches,0);
 const before=probes;coordinator.wake();await flush(f);assert.equal(probes,before,'ordinary wake does not poll old Sessions');
 busy=false;callbacks.get(w.execution.sessionId)!();await flush(f);task=await f.get();
 assert.equal(task.executions[w.execution.executionId].physicalState,'lost');assert.equal(launches,1);assert.equal(callbacks.size,0);
 assert.equal(task.children.a.assignmentVersion,1);assert.equal(task.children.a.activeExecutionId,'successor-1');assert.deepEqual(errors,[]);
});


class NativeOwner {
 sessionId='';actualAgent={inbox:{nextTurn:[],nextStep:[]}};state:'running'|'idle'|'stopped'='idle';listeners=new Set<()=>void>();waiters:Array<()=>void>=[];disposals=0;
 observe(){return {state:this.state,jobs:[]}};emit(){for(const fn of [...this.listeners])fn()};idle(){this.state='idle';for(const fn of this.waiters.splice(0))fn();this.emit()}
 async send(){this.state='running';this.emit()};whenIdle(){return this.state==='running'?new Promise<void>(r=>this.waiters.push(r)):Promise.resolve()}
 async cancel(){if(this.state!=='stopped')this.idle()};async dispose(){if(this.state==='stopped')return;this.disposals++;this.state='stopped';for(const fn of this.waiters.splice(0))fn()};getMessages(){return []};hasMessage(){return false};subscribe(fn:()=>void){this.listeners.add(fn);return()=>this.listeners.delete(fn)}
}

test('disposed native handle is retained until its stopped-state commit succeeds, then handoff proceeds without a second disposal',async t=>{
 const f=await planned(), native=new NativeOwner(), errors:any[]=[];
 const supervisor=new AgentSupervisor({tasks:f.tasks,knowledge:{list:async()=>[]} as any,defaults:{version:'test',presetId:'test',foreground:{},background:{}},setupRole(){},onError:e=>errors.push(e),
 gateway:{exists:async()=>false,create:async(req:any)=>{native.sessionId=req.sessionId;return native}} as any});
 t.after(()=>supervisor.dispose());
 let task=await f.get();const action=Object.values(task.pendingActions).find(a=>a.kind==='dispatch'&&a.status==='pending')!;
 await f.execute({type:'action.claim',actionId:action.id,ownerId:'test'});await supervisor.start(await f.get(),action);await f.execute({type:'action.finish',actionId:action.id});
 task=await f.get();const w=Object.values(task.executions).find(e=>e.role==='worker')!;
 const execute=f.tasks.execute.bind(f.tasks);let failed=false;
 f.tasks.execute=async(id,input)=>{if(!failed&&input.commandId.startsWith('released:')){failed=true;throw Object.assign(new Error('release record occupied'),{code:'EBUSY'})}return execute(id,input)};
 assert.equal((await f.execute({type:'execution.report',report:{resultId:'handoff',assignmentVersion:1,outcome:'handoff',summary:'stage saved',artifacts:[],evidence:['saved'],frontier:'next',checkpoint:{completed:['one'],remaining:['two'],failedApproaches:[],nextAction:'two',nextReads:[]}}},{kind:'agent',id:w.agentId,sessionId:w.sessionId,executionId:w.executionId,role:'worker'})).status,'applied');
 native.idle();await flush(f);task=await f.get();
 assert.equal(native.disposals,1);assert.equal(supervisor.get(w.executionId),undefined);assert.equal(task.executions[w.executionId].physicalState,'stopped');
 const next=Object.values(task.pendingActions).find(a=>a.kind==='dispatch'&&a.status==='pending')!;
 assert.equal(new Scheduler().canRun(task,next,[task],supervisor.live()).allowed,true);
 assert.ok(errors.length>=1);

});

test('resume recovers failed Planner launch under the same semantic action with a new owner, not a sticky failed-action blacklist',async t=>{
 const f=await fixture(), errors:any[]=[]; let opens=0; const native=new NativeOwner();
 const supervisor=new AgentSupervisor({tasks:f.tasks,knowledge:{list:async()=>[]} as any,defaults:{version:'test',presetId:'test',foreground:{},background:{}},setupRole(){},onError:e=>errors.push(e),
  gateway:{exists:async()=>false,create:async(req:any)=>{opens++;if(opens===1)throw Object.assign(new Error('temporary native session file occupied'),{code:'EBUSY'});native.sessionId=req.sessionId;return native}} as any});
 const coordinator=new RuntimeCoordinator({tasks:f.tasks,supervisor,assistants:{} as any,knowledge:{} as any,sessions:{inspect:async()=>emptyInspection(),probeOwnership:async()=> 'absent'} as any,onError:e=>errors.push(e)});
 t.after(async()=>{await coordinator.dispose();await supervisor.dispose()});
 const original=Object.values((await f.get()).pendingActions).find(a=>a.kind==='plan')!;
 await coordinator.start();await flush(f);let task=await f.get();assert.equal(opens,1);assert.equal(task.pendingActions[original.id].status,'uncertain');
 await f.execute({type:'task.control',intent:'resume'},{kind:'user',id:'owner'});await flush(f);task=await f.get();
 assert.equal(task.pendingActions[original.id].status,'running');assert.equal(Object.values(task.incidents).every(i=>i.state==='resolved'),true);
 assert.equal((coordinator as any).failed.has('one/'+original.id),false);assert.equal(opens,2);
 assert.equal(Object.values(task.executions).filter(e=>e.state==='active').length,1);
 assert.equal(Object.values(task.executions).find(e=>e.state==='active')?.generation,2);
 assert.equal(errors.length,1);
});

test('ordinary resume releases only runtime repeated-fault pauses; genuine configuration waits remain',async()=>{
 const f=await planned();let w=await f.bind('dispatch','a');
 for(let n=0;n<3;n++) {
  await f.execute({type:'incident.open',executionId:w.execution.executionId,operation:'native Agent error',message:'transport interrupted'});
  await f.execute({type:'execution.observed',executionId:w.execution.executionId,physicalState:'lost',ownedJobIds:[]});
  let task=await f.get();const incident=Object.values(task.incidents).find(i=>i.executionId===w.execution.executionId)!;
  assert.equal(incident.repeatCount,n+1);
  if(n>0) {
   assert.equal(incident.state,'waiting');assert.equal(Object.values(task.pendingActions).some(a=>a.kind==='recover'&&a.payload.incidentId===incident.id&&a.status==='pending'),false);
   assert.equal(Object.values(task.waits).find(wait=>wait.incidentId===incident.id)?.kind,'recovery');
   await f.execute({type:'task.control',intent:'resume'},{kind:'user',id:'owner'});
   task=await f.get();assert.equal(task.incidents[incident.id].state,'open');
  }
  await f.execute({type:'recovery.restart',incidentId:incident.id,evidence:'native owner absent'});
  w=await f.bind('dispatch','a');
 }
 await f.execute({type:'execution.requestHelp',kind:'configuration',operation:'missing explicit setting',message:'need chosen setting',wait:{id:'real-config',kind:'configuration',reason:'need setting',condition:'User must choose output target',resume:'Use the chosen target'}},w.source);
 await f.execute({type:'task.control',intent:'resume'},{kind:'user',id:'owner'});
 assert.equal((await f.get()).waits['real-config'].state,'waiting');
});

test('ordinary resume recognizes the exact historical runtime-generated configuration wait without clearing other waits',async()=>{
 const f=await planned();let w=await f.bind('dispatch','a');
 for(let n=0;n<2;n++) {
  await f.execute({type:'incident.open',executionId:w.execution.executionId,operation:'native Agent error',message:'same failure'});
  await f.execute({type:'execution.observed',executionId:w.execution.executionId,physicalState:'lost',ownedJobIds:[]});
  const task=await f.get(), incident=Object.values(task.incidents).find(i=>i.executionId===w.execution.executionId)!;
  if(n===0){await f.execute({type:'recovery.restart',incidentId:incident.id,evidence:'native gone'});w=await f.bind('dispatch','a')}
  else {
   const wait=Object.values(task.waits).find(w=>w.incidentId===incident.id)!;delete task.waits[wait.id];
   wait.id=incident.id+':configuration';wait.kind='configuration';delete wait.runtimeReason;
   wait.condition='Correct the reported fault or confirm a changed environment before another attempt.';
   wait.resume='Continue the same role from the preserved checkpoint after this condition is explicitly resolved.';
   task.waits[wait.id]=wait;task.revision++;await f.store.putTask(task);
   await f.execute({type:'task.control',intent:'resume'},{kind:'user',id:'owner'});
   const next=await f.get();assert.equal(next.waits[wait.id].state,'resolved');assert.equal(next.waits[wait.id].runtimeReason,'repeated-fault');assert.equal(next.incidents[incident.id].state,'open');
  }
 }
});

test('ownership watch hears only the exact native owner and settlement lifecycle, then fully unsubscribes',()=>{
 const events=new Map<string,Function>();let jobListener:Function|undefined, changes=0;
 const reader=new DshSessionReader({on:(type:string,fn:Function)=>{events.set(type,fn);return()=>events.delete(type)},jobs:{events:{subscribe:(filter:any,fn:Function)=>{assert.equal(filter.owner,'exact-session');jobListener=fn;return()=>{jobListener=undefined}}}}} as any);
 const stop=reader.watchOwnership('exact-session',()=>changes++);
 events.get('agent/disposed')!({agent:{id:'other'}});events.get('session/disposed')!({id:'other'});
 jobListener!({type:'settled',job:{owner:'other'}});jobListener!({type:'progress',job:{owner:'exact-session'}});assert.equal(changes,0);
 events.get('agent/disposed')!({agent:{id:'exact-session'}});events.get('session/disposed')!({id:'exact-session'});
 jobListener!({type:'settled',job:{owner:'exact-session'}});assert.equal(changes,3);stop();assert.equal(events.size,0);assert.equal(jobListener,undefined);
});

test('force-stop keeps the exact disposed handle on failed observation and safely retries the same durable identity',async t=>{
 const f=await planned(), native=new NativeOwner(), supervisor=new AgentSupervisor({tasks:f.tasks,knowledge:{list:async()=>[]} as any,defaults:{version:'test',presetId:'test',foreground:{},background:{}},setupRole(){},onError(){},
  gateway:{exists:async()=>false,create:async(req:any)=>{native.sessionId=req.sessionId;return native}} as any});
 t.after(()=>supervisor.dispose());let task=await f.get();const action=Object.values(task.pendingActions).find(a=>a.kind==='dispatch'&&a.status==='pending')!;
 await f.execute({type:'action.claim',actionId:action.id,ownerId:'test'});await supervisor.start(await f.get(),action);await f.execute({type:'action.finish',actionId:action.id});
 const owner=Object.values((await f.get()).executions).find(e=>e.role==='worker')!;
 const execute=f.tasks.execute.bind(f.tasks);let failed=false;
 f.tasks.execute=async(id,input)=>{if(!failed&&input.commandId.startsWith('reset-stop:')){failed=true;throw new Error('temporary occupied stopped record')}return execute(id,input)};
 await assert.rejects(supervisor.forceStopTasks(['one']));
 assert.equal(native.disposals,1);assert.equal(supervisor.get(owner.executionId),native);
 await supervisor.forceStopTasks(['one']);assert.equal(native.disposals,1);assert.equal(supervisor.get(owner.executionId),undefined);assert.equal((await f.get()).executions[owner.executionId].physicalState,'stopped');
});
