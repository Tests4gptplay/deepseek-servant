// Consumer regression from the parent's actual failed Service/SDK run.
// Copies real persisted state; does not seed Task completion or simulate an I/O fault.
// This is captured-state consumer replay, not a second full live admission run.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
const {evidence,hash}=await import('./test-support/dsh-sdk-runtime.mjs')
const {openDshStorageFixture}=await import('./test-support/dsh-sdk-storage.mjs')
const {FrameworkRoleRuntime}=await import('../src/framework/role-runtime.ts')
const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const source=process.argv[2],output=process.argv[3]
assert(source&&output,'Pass actual failed fixture directory and new output directory')
const log=await fs.readFile(source+'.log','utf8'),events=log.split('\n').flatMap(line=>{const i=line.indexOf(' ');try{return[{event:line.slice(0,i),...JSON.parse(line.slice(i+1))}]}catch{return[]}})
const observation=events.find(x=>x.event==='finished-A-ancestry-observation'&&x.label==='after-normal-active-stop-rejoin-1')
const captured=observation.retained.find(row=>!row.value.delivered&&row.value.recovery?.targetExecutionId)
assert(captured,'actual failed run must contain its unadmitted closed continuation')
const target=captured.value.recovery.targetExecutionId,retired=events.flatMap(x=>x.record?.nativeRetirements??[]).find(x=>x.executionId===target)
assert(retired,'original exact native retirement was recorded by the actual run')
await fs.mkdir(output,{recursive:true})
await fs.cp(path.join(source,'task-end-helper-claims','business'),path.join(output,'business'),{recursive:true})
await fs.cp(path.join(source,'task-end-helper-claims','storage'),path.join(output,'storage'),{recursive:true})
const sdk=await openDshStorageFixture(path.join(output,'storage'),path.join(output,'locator')),files=new PhysicalLocalFiles(path.join(output,'business'))
const prefix=captured.key.slice(0,captured.key.indexOf('wakes/')),rows=await sdk.adapter.list(prefix+'roles/'),rt=Object.create(FrameworkRoleRuntime.prototype)
Object.assign(rt,{files,records:sdk.adapter,prefix,config:{mode:'local',member:'Evidence'},roleRecords:new Map(rows.map(r=>[r.value.identity.workId,r.value])),wakeWrites:new Map(),helperWakeWrites:new Map(),safetyEpisodes:new Map(),taskHelperWakes:new Map(),localWakeAdmissions:new Map(),reportedAdmissionDiagnostics:new Set(),admissionObservationVersion:0,roleWrites:new Map(),roleBases:new Map(),resolvedSafetyFaultIds:new Set()})
const checks=[],check=(n,a,b)=>{assert.deepEqual(a,b,n);checks.push(n)}
try{
 const request=retired.helper.delivery.request,owner=rt.helperTaskOwner(request)
 check('actual copied A history is terminal and released',await rt.releasedHelperTask(owner),true)
 const before=await sdk.adapter.list(prefix+'wakes/'),wake=await sdk.adapter.get(captured.key)
 check('copied original wake still unadmitted',!!wake&&!wake.delivered,true)
 check('exact original recovery input preserved',JSON.stringify(wake.recovery.original.request),JSON.stringify(request))
 const signal=wake.helperSignal,signalBefore=await files.fileMetadata(signal),current=rt.roleRecords.get(rt.roleKey('Helper')),roleBefore=JSON.stringify(await sdk.adapter.get(prefix+'roles/'+hash(current.identity.workId)))
 check('actual pending continuation owns its signal',!!signalBefore,true)
 const debug=wake.request.context.helperDebugPath,debugBefore=await fs.readFile(path.join(output,'business',debug),'utf8')
 await rt.retireUnadmittedHelperContinuation(retired,request)
 check('precise captured pending A continuation retired',await sdk.adapter.get(captured.key),undefined)
 check('its own signal retired in same operation',await files.fileMetadata(signal),undefined)
 check('Host summary and other native ownership untouched',JSON.stringify(await sdk.adapter.get(prefix+'roles/'+hash(current.identity.workId))),roleBefore)
 const after=await sdk.adapter.list(prefix+'wakes/')
 check('all unrelated original WakeRecords byte-preserved',JSON.stringify(after),JSON.stringify(before.filter(r=>r.key!==captured.key)))
 check('long-term Debug unchanged',await fs.readFile(path.join(output,'business',debug),'utf8'),debugBefore)
 console.log(JSON.stringify({status:'passed',checks:checks.length,checksDetail:checks,capturedKey:captured.key,target,source,sdk:evidence(),limits:'Exact captured-state consumer replay from an actual Service failure; no Task completion or failure state fabricated. It does not claim a new full live two-order admission test.'},null,2))
}finally{await files.close();await sdk.close()}
