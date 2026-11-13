import assert from 'node:assert/strict'
import {existsSync,readFileSync} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {registerHooks,stripTypeScriptTypes} from 'node:module'
import {createHash} from 'node:crypto'
const root=new URL('../src/',import.meta.url),loaded=new Map(),data=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64')
const hooks=registerHooks({resolve(s,c,n){if(s==='zod')return{url:data(`const s=new Proxy(function(){},{get(_t,k){if(k==='parse')return v=>v;return s},apply(){return s}});export const z=s;`),shortCircuit:true};if(s.startsWith('.')&&c.parentURL?.startsWith(root.href)&&s.endsWith('.js')){const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(fileURLToPath(u)))return{url:u.href,shortCircuit:true}}return n(s,c)},load(u,c,n){if(u.startsWith(root.href)&&u.endsWith('.ts')){const s=readFileSync(new URL(u),'utf8');loaded.set(u.slice(root.href.length),createHash('sha256').update(s).digest('hex'));return{format:'module',source:stripTypeScriptTypes(s,{mode:'transform'}),shortCircuit:true}}return n(u,c)}})

const {FrameworkSafetyNet}=await import('../src/framework/safety-net.ts')
const runtimeSource=readFileSync(new URL('framework/role-runtime.ts',root),'utf8')
function method(name){const start=runtimeSource.indexOf('  private '+name);assert(start>=0,name);const next=runtimeSource.indexOf('\n  private ',start+4);return runtimeSource.slice(start,next)}
const Scope=new Function('hash',stripTypeScriptTypes('class Scope {\n'+method('async recordSafetyAttempt(')+'\n'+method('helperResponsibilities(')+'\n'+method('safetyFaultFromWake(')+'\n'+method('replaySafetyWakes(')+'\n}',{mode:'transform'})+'\nreturn Scope')(text=>createHash('sha256').update(text).digest('hex'))
let assertions=0;const check=(a,b)=>{assert.deepEqual(a,b);assertions++}
try {
 const net=new FrameworkSafetyNet('current-host'),context={mode:'local',scope:'scope',source:'actual-operation'},error=new Error('initial failure')
 const first=net.capture(error,context,net.begin());check(first.state,'repairing')
 net.failed(first.faultId,'attempt-one',new Error('actual recovery failed'),false)
 check(net.presentation(first.faultId),{faultId:first.faultId,state:'repairing'})
 net.capture(new Error('initial failure'),context,net.begin());check(net.presentation(first.faultId).state,'repairing')
 const fault=net.fault(first.faultId)
 const restored=new FrameworkSafetyNet('new-host');restored.capture(error,context,restored.begin());restored.restore(fault,{attemptId:'attempt-one',failure:'still failed',terminal:false,displayOwner:'old-host'})
 check(restored.presentation(fault.id).state,'repairing');check(restored.presentation(fault.id).message,undefined)
 // Only an explicit terminal presentation decision exposes this fault; no
 // occurrence count, old Host or failed low-level reset infers that decision.
 net.failed(first.faultId,'attempt-two','actual reported remaining issue',true)
 check(net.presentation(first.faultId),{faultId:first.faultId,state:'visible',message:'actual reported remaining issue'})
 function makeRuntime(selectedFault){const runtime=new Scope(),resolutions=[],attempted=[],replayed=[];runtime.prefix='runtime/';runtime.roleRecords=new Map([['helper',{identity:{role:'Helper',executionId:'helper-execution'},lastWake:{id:'helper-wake'}}]]);runtime.safetyEpisodes=new Map([[selectedFault.id,{fault:selectedFault,helperWakeId:'helper-wake',commands:new Set()}]]);runtime.safetyReplayed=new Set();runtime.resolvedSafetyFaultIds=new Set();runtime.environment={safetyResolved:id=>resolutions.push(id),safetyAttempted:(...a)=>attempted.push(a),safetyReplay:(...a)=>replayed.push(a),safetyDisplayOwner:()=> 'actual-host'};runtime.wake={request:{id:'helper-wake'}};runtime.updateWake=async(k,fn)=>{runtime.wake=JSON.parse(JSON.stringify(fn(runtime.wake)));return runtime.wake};runtime.replaySafetyWake=()=>{};return{runtime,resolutions,attempted,replayed}}
 const caller={role:'Helper',workId:'helper',executionId:'helper-execution'}
 const actual=makeRuntime(fault)
 await actual.runtime.recordSafetyAttempt(caller,{faultId:fault.id,actionsTaken:'Actual first repair',outcome:'attempted-not-repaired',result:'Needs further diagnosis'},'helper-report-one')
 check(actual.resolutions,[]);check(actual.attempted,[])
 await actual.runtime.recordSafetyAttempt(caller,{faultId:fault.id,actionsTaken:'Actually restored continuation',outcome:'repaired',result:'Original task continues'},'helper-report-two')
 check(actual.resolutions,[fault.id]);check(actual.runtime.wake.resolvedSafetyFaultIds,[fault.id]);check(actual.attempted,[[fault.id,'helper-report-two']])
 const cold=makeRuntime(fault);cold.runtime.safetyEpisodes.clear();cold.runtime.replaySafetyWakes([actual.runtime.wake]);check(cold.resolutions,[fault.id]);check(cold.replayed,[])
 const old={...actual.runtime.wake};delete old.resolvedSafetyFaultIds
 const oldCold=makeRuntime(fault);oldCold.runtime.safetyEpisodes.clear();oldCold.runtime.replaySafetyWakes([old]);check(oldCold.runtime.resolvedSafetyFaultIds.has(fault.id),true);check(oldCold.resolutions,[fault.id])
 const unknown={...fault,id:'unknown-operation',operationId:'original-unknown-operation'},pending=makeRuntime(unknown)
 await pending.runtime.recordSafetyAttempt(caller,{faultId:unknown.id,actionsTaken:'Restored environment',outcome:'repaired',result:'Environment repaired; original operation outcome still unknown'},'helper-unknown')
 check(pending.runtime.wake.resolvedSafetyFaultIds,undefined);check(pending.runtime.resolvedSafetyFaultIds.has(unknown.id),false);check(pending.resolutions,[unknown.id]);check(pending.runtime.safetyEpisodes.get(unknown.id).fault.operationId,'original-unknown-operation')
 const service=readFileSync(new URL('framework/service.ts',root),'utf8')
 const section=(start,end)=>{const from=service.indexOf(start);assert(from>=0,start);const to=service.indexOf(end,from+start.length);assert(to>from,end);return service.slice(from,to)}
 const ServiceScope=new Function(stripTypeScriptTypes('class ServiceScope {\n'+[
  section('    private refreshErrors(', '    private sameSafetyFault('),
  section('    private resolveSafetyFault(', '    private resolveRoleErrors('),
  section('    private safetyCallbacks(', '    /** One occurrence starts before an RPC.'),
  section('    errorPresentation(', '    async clientFault('),
  section('    private settingsView(', '    async view(')
 ].join('\n')+'\n}',{mode:'transform'})+'\nreturn ServiceScope')()
 const {frameworkErrorText}=await import('../src/framework/client-error.ts')
 function makeService(){const value=new ServiceScope();value.safetyNet=new FrameworkSafetyNet('view-host');value.reportedErrors=new Map();value.errors=new Map();value.userErrors=new Map();value.resolvedSafetyFaultIds=new Set();value.resolvedRoleFacts=new Set();value.safetyErrors=new WeakMap();value.running=new Map();value.archiveViews=new Map();value.displayOwner='view-host';value.config=()=>({revision:1,settings:{collaborationId:'conversation'}});value.changed=()=>{};value.safetyChanged=()=>{};value.deliverSafetyFaults=()=>{};return value}
 const ui=makeService(),originalOperation=new Error('original outcome remains unknown'),uiContext={...context,operationId:unknown.operationId}
 const uiPresentation=ui.safetyNet.capture(originalOperation,uiContext,ui.safetyNet.begin()),uiFault=ui.safetyNet.fault(uiPresentation.faultId)
 ui.reportedErrors.set('local',new Map([['original-operation',{message:originalOperation.message,operationId:unknown.operationId,safety:uiPresentation}]]));ui.safetyErrors.set(originalOperation,uiPresentation)
 ui.safetyCallbacks('local').safetyResolved(uiFault.id)
 check(ui.safetyNet.presentation(uiFault.id),{faultId:uiFault.id,state:'awaiting-outcome'})
 check(ui.reportedErrors.get('local').get('original-operation').operationId,unknown.operationId)
 check(ui.resolvedSafetyFaultIds.has(uiFault.id),false)
 check(ui.errors.get('local'),'original outcome remains unknown')
 check(ui.settingsView('local').connection.detail,undefined)
 check(ui.errorPresentation(originalOperation).state,'awaiting-outcome')
 check(frameworkErrorText({message:originalOperation.message,safetyNet:ui.errorPresentation(originalOperation)}),'')
 // Cold replay uses the actual persisted Helper report and service callbacks.
 const coldUi=makeService(),coldUnknown=makeRuntime(unknown)
 coldUnknown.runtime.safetyEpisodes.clear();coldUnknown.runtime.environment={...coldUnknown.runtime.environment,...coldUi.safetyCallbacks('local')}
 coldUnknown.runtime.replaySafetyWakes([pending.runtime.wake])
 check(coldUi.safetyNet.presentation(unknown.id).state,'awaiting-outcome')
 check(coldUi.reportedErrors.get('local').get('safety:'+unknown.id).operationId,unknown.operationId)
 check(coldUi.settingsView('local').connection.detail,undefined)
 check(coldUnknown.runtime.resolvedSafetyFaultIds.has(unknown.id),false)
 coldUnknown.runtime.replaySafetyWakes([pending.runtime.wake]);check(coldUi.safetyNet.presentation(unknown.id).state,'awaiting-outcome')
 // A later actual unrepaired occurrence still cannot independently override
 // the Helper decision with a notification or a successful storage result.
 coldUi.safetyNet.capture(new Error(unknown.message),{...unknown,code:unknown.fingerprint},coldUi.safetyNet.begin())
 check(coldUi.safetyNet.fault(unknown.id).operationId,unknown.operationId)
 net.resolved(first.faultId);check(net.presentation(first.faultId),undefined)
 console.log(JSON.stringify({status:'passed',assertions,limits:'Actual SafetyNet, actual Helper report/replay and service callbacks/settings-view/error presentation method bodies with explicit persisted-wake/native owner fixtures. Explicit Helper user-message tool and original UNKNOWN transport resolution are not simulated as succeeded.',sourceHashes:{...Object.fromEntries(loaded),'framework/role-runtime.ts':createHash('sha256').update(runtimeSource).digest('hex')}},null,2))
}finally{hooks.deregister()}
