import assert from 'node:assert/strict'
import {AsyncLocalStorage} from 'node:async_hooks'
import * as deps from './test-support/dsh-sdk-runtime.mjs'
import {gitFixture} from './helper-retirement-git-fixture.mjs'
const {FrameworkSafetyNet}=await import('../src/framework/safety-net.ts')
const {FrameworkService}=await import('../src/framework/service.ts')
const {withSnapshot}=await import('../src/framework/transactions.ts')
const {Context}=await import('@deepseek-ai/cordis')
const {SystemPrompt}=await import('@deepseek-ai/dsh-system-prompt')
const {ToolRuntime}=await import('@deepseek-ai/dsh-tools')
const {createScope}=await import('@deepseek-ai/dsh-scope')
const {installFrameworkRoleTools}=await import('../src/framework/role-tools.ts')
let checks=0;const check=(a,b)=>{assert.deepEqual(a,b);checks++}
// Controlled fault inputs exercise an explicitly requested state-machine rule.
// They do not prove a naturally occurring filesystem/transport incident.
const context={mode:'git',scope:'test',source:'agent',taskId:'original-task',identity:{role:'Planner',taskId:'original-task',workId:'original-planner',executionId:'original-execution'}}
const net=new FrameworkSafetyNet('test-host'),h=await gitFixture(),rt=h.rt,jobs=[]
const service=Object.create(FrameworkService.prototype),reported=[]
Object.assign(service,{safetyNet:net,safetyOperations:new AsyncLocalStorage(),safetyErrors:new WeakMap(),safetyDeliveries:new Set(),running:new Map(),saved:new Map(),reportedErrors:new Map(),errors:new Map(),userErrors:new Map(),resolvedRoleFacts:new Set(),resolvedSafetyFaultIds:new Set(),listeners:new Set(),ctx:{logger:()=>({error:e=>reported.push(e.message)})},closed:false,displayOwner:'test-host'})
Object.assign(rt,{safetyRequests:new Map(),unavailableSafetyTargets:new Map(),resolvedSafetyFaultIds:new Set(),safetyErrorOccurrences:new WeakMap(),safetyContext:new AsyncLocalStorage(),environment:{...service.safetyCallbacks('git'),error:(error,origin,occurrence)=>service.report('git',error,'test',undefined,origin,occurrence)}})
service.running.set('git',{connection:{scope:'test'},runtime:rt})
rt.startMaintenance=(_id,action)=>jobs.push(action())
async function observed() {
 const error=new Error('same actual observed fault')
 rt.error(error,{identity:context.identity,taskId:context.taskId,safetyOccurrence:net.begin()})
 const until=Date.now()+5000
 while(service.safetyDeliveries.size){if(Date.now()>until)throw Error('Test waiting for existing Safety delivery');await new Promise(setImmediate)}
 await Promise.all(jobs)
 return service.errorPresentation(error)
}
const scopes=[]
async function accept(wake,inputId) {
 const source=await withSnapshot(rt.files,async s=>(await rt.files.listDirectory(s,'state/',{paths:[wake.helperSignal]}))[0])
 assert(source)
 const request={...wake.request,sources:[{path:source.path,version:source.version}]}
 const previous=rt.roleRecords.get(h.record.identity.workId)
 const role={...previous,lastWake:request,delivery:{request,messageId:inputId,confirmed:true},gitSettledWakeId:undefined}
 await rt.updateWake(rt.prefix+'wakes/'+deps.hash(request.id),current=>({...current,request,delivered:true,nativeOwner:rt.gitRuntimeOwner?.(role),nativeInputId:inputId}))
 await rt.saveRole({...role,delivery:{...role.delivery,confirmed:false}},false,'prepare');h.input(inputId)
 await rt.saveRole({...rt.roleRecords.get(role.identity.workId),delivery:{...role.delivery,confirmed:true}},false,'confirm')
 const binding=rt.binding(rt.roleRecords.get(role.identity.workId),request),ctx=new Context();new SystemPrompt(ctx,{});new ToolRuntime(ctx)
 ctx.provide('sessions',{flush:async()=>{}})
 const scope=createScope(ctx,h.actual);scopes.push(scope)
 installFrameworkRoleTools(scope.ctx,h.actual,binding,rt.services())
 const call=async(id,name,args={})=>{h.call(id,name,args);const value=await ctx.tools.execute({name,arguments:args,agent:h.actual,callId:id,signal:new AbortController().signal});if(value.isError)throw Error(value.error?.message??JSON.stringify(value));h.result(id,JSON.stringify(value.value));return value.value}
 const claimed=await call(inputId+'-claim','dss_claim')
 check(await withSnapshot(rt.files,s=>rt.files.read(s,wake.helperSignal)),undefined)
 return {call,binding,claimed,recordPath:request.context.helperDebugPath}
}

try {
 const boundaryNet=new FrameworkSafetyNet('boundary-host'),initial=boundaryNet.capture(new Error('boundary fault'),context,boundaryNet.begin())
 boundaryNet.assigned(initial.faultId);boundaryNet.failed(initial.faultId,'failed-first-action','still handling')
 check(boundaryNet.capture(new Error('boundary fault'),context,boundaryNet.begin()).faultId,initial.faultId)
 check(boundaryNet.pending('git','test'),[])
 boundaryNet.attempted(initial.faultId,'original-continuation-restored',true)
 check(boundaryNet.capture(new Error('boundary fault'),context,boundaryNet.begin()).faultId===initial.faultId,false)
 const first=await observed(),fault=net.fault(first.faultId),oldOperation=net.begin()
 const episode=rt.safetyEpisodes.get(fault.id),oldWake=await rt.records.get(rt.prefix+'wakes/'+deps.hash(episode.helperWakeId))
 check(oldWake.request.context.safetyFault.id,fault.id)
 check(oldWake.request.context.helperDebugPath.includes('/tasks/original-task/'),true)
 check((await withSnapshot(rt.files,s=>rt.files.read(s,oldWake.helperSignal))),'')
 // Repeated observation before any Helper action stays this first input.
 check((await observed()).faultId,fault.id)
 check(net.pending('git','test'),[])
 const firstRun=await accept(oldWake,'accepted-first'),firstView=await firstRun.call('snapshot-first','dss_snapshot')
 await firstRun.call('first-report','dss_record',{snapshotId:firstView.snapshotId,path:firstRun.recordPath,text:'First actual diagnosis and handling; original work continues.\n',append:true,repairAttempt:{faultId:fault.id,actionsTaken:'Actual first handling recorded',outcome:'attempted-not-repaired',result:'Original work continues; observation still needed'}})
 const firstReportCommand=h.actual.id+':first-report'
 check(net.pending('git','test'),[])
 check(net.capture(new Error(fault.message),context,0).faultId,fault.id)
 check(net.capture(new Error(fault.message),context,oldOperation).faultId,fault.id)
 check(net.pending('git','test'),[])
 check((await observed()).faultId,fault.id)
 check(net.pending('git','test'),[])
 const repairedView=await firstRun.call('snapshot-first-repaired','dss_snapshot')
 await firstRun.call('first-repaired','dss_record',{snapshotId:repairedView.snapshotId,path:firstRun.recordPath,text:'First repair completed; original continuation restored.\n',append:true,repairAttempt:{faultId:fault.id,actionsTaken:'Restored original continuation',outcome:'repaired',result:'Original task continues'}})
 check(net.fault(fault.id),undefined)
 const second=await observed(),next=net.fault(second.faultId)
 check(second.faultId===fault.id,false)
 check(next.fingerprint,fault.fingerprint)
 check(next.taskId,fault.taskId)
 check(second.state,'repairing');check(net.pending('git','test'),[])
 const nextEpisode=rt.safetyEpisodes.get(next.id),newWake=await rt.records.get(rt.prefix+'wakes/'+deps.hash(nextEpisode.helperWakeId))
 check(newWake.request.id===oldWake.request.id,false)
 check(newWake.request.context.helperDebugPath,oldWake.request.context.helperDebugPath)
 check(newWake.helperSignal===oldWake.helperSignal,false)
 check(newWake.signalsConsumed,undefined)
 check((await withSnapshot(rt.files,s=>rt.files.read(s,newWake.helperSignal))),'')
 // Finishing/replaying the earlier responsibility must not resolve the newer one.
 check(service.resolvedSafetyFaultIds.has(fault.id),true);check(net.fault(next.id).id,next.id)
 for(const reverse of [false,true]) {
  const cold=new FrameworkSafetyNet('cold-host')
  const inputs=[[fault,{attemptId:firstReportCommand}],[next,{}]]
  if(reverse)inputs.reverse()
  for(const [f,r] of inputs)cold.restore(f,r)
  check(cold.fault(next.id).id,next.id);check(cold.fault(fault.id).id,fault.id)
  check(cold.capture(new Error(fault.message),context,0).faultId,next.id)
  check(cold.capture(new Error(fault.message),context,cold.begin()).faultId,next.id)
  cold.resolved(fault.id);check(cold.fault(next.id).id,next.id)
 }
 check(net.pending('git','test'),[])
 // Explicit repaired reporting follows the existing resolved callback. A later
 // real fault must still publish a new signal while that Helper is finishing.
 const secondRun=await accept(newWake,'accepted-second'),secondView=await secondRun.call('snapshot-second','dss_snapshot')
 await secondRun.call('second-report','dss_record',{snapshotId:secondView.snapshotId,path:secondRun.recordPath,text:'Repeated actual fault: Helper judges user attention required.\n',append:true,notifyForeground:true,repairAttempt:{faultId:next.id,actionsTaken:'Restored original continuation',outcome:'repaired',result:'Original work can continue'}})
 const reportSignals=await withSnapshot(rt.files,async view=>(await rt.files.list(view,'state/')).filter(x=>x.path.startsWith('state/Foreground_Helper_Report_')))
 check(reportSignals.length,1)
 check((await withSnapshot(rt.files,s=>rt.files.read(s,secondRun.recordPath))).includes('First actual diagnosis'),true)
 check((await withSnapshot(rt.files,s=>rt.files.read(s,secondRun.recordPath))).includes('Repeated actual fault'),true)
 check(net.fault(next.id),undefined)
 const afterRepair=await observed(),third=net.fault(afterRepair.faultId)
 const thirdEpisode=rt.safetyEpisodes.get(third.id),thirdWake=await rt.records.get(rt.prefix+'wakes/'+deps.hash(thirdEpisode.helperWakeId))
 check(thirdWake.request.id===newWake.request.id,false)
 check(thirdWake.request.context.helperDebugPath,newWake.request.context.helperDebugPath)
 check((await withSnapshot(rt.files,s=>rt.files.read(s,thirdWake.helperSignal))),'')
 check(thirdWake.request.context.safetyFault.id,third.id)
 console.log(JSON.stringify({status:'passed',checks,...deps.evidence(),limits:'Controlled fault events and native ownership; actual Service report/capture/delivery and callbacks, SafetyNet, Runtime error/request/report/claim, registered installed-SDK snapshot/claim/record tools, Git authority/transactions, original Helper state publication and final Foreground signal. In-memory Git transport. No natural model, user incident, full startup/real restoration execution, Windows or online Git claim.'},null,2))
}finally{for(const scope of scopes)await scope.dispose();deps.hooks.deregister()}
