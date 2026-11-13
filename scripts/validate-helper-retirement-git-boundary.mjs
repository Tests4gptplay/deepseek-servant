// Production Git Runtime/authority/transactions, controlled Git transport and
// native read/Cleaner ports. Supplementary boundary check, not a live Git Host.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {evidence} from './test-support/dsh-sdk-runtime.mjs'
import {gitFixture} from './helper-retirement-git-fixture.mjs'
const {FrameworkRoleRuntime}=await import('../src/framework/role-runtime.ts')
const {gitCommandReceiptPath}=await import('../src/framework/command-transactions.ts')
const {withSnapshot}=await import('../src/framework/transactions.ts')
let checks=0;const check=(a,b)=>{assert.deepEqual(a,b);checks++},tick=()=>new Promise(setImmediate)
const f=await gitFixture(),rt=f.rt,errors=[],retirements=[]
rt.error=(e,c)=>errors.push({error:String(e),context:c});rt.taskMetadata=async()=>[]
const input={facts:'Known controlled original Host.',hypotheses:'No business Task fault claimed.',actionsTaken:'Normal accepted restore.',continuation:'Use original Host restore.'}
const commandId=f.record.sessionId+':restore'
await rt.services().helper.restoreHost({...f.record.identity,owner:'A'},input,commandId)
f.input();const call=f.call('restore','dss_restore_host',input)
f.add('tool/result',{turn:1,step:0,message:{toolCallId:'restore',isError:false,content:[]}},{surfaceOp:'append',sourceEventSeqs:[call.seq]})
await rt.saveRole({...f.record,stopped:true})
const gate=Promise.withResolvers();let reads=0,saveReturned=false
rt.ctx.sessions.get=()=>undefined
rt.ctx.get=name=>name==='sessionPersistence'?{stat:async()=>({}),open:async()=>{reads++;await gate.promise;return{read:async()=>({events:f.events}),close:async()=>{}}}}:name==='nativeSessionCleaner'?{retire:async id=>{retirements.push(id)}}:undefined
rt.continueNativeRetirements=FrameworkRoleRuntime.prototype.continueNativeRetirements
const replacement={identity:{...f.record.identity,executionId:'replacement'},sessionId:'replacement-session',generation:2}
const saving=rt.saveRole(replacement).then(()=>{saveReturned=true})
// Wait only for the already-started native read boundary, not a wall-clock
// duration. Its delayed I/O must not hold the new RoleRecord commit.
for(let n=0;n<100&&!reads;n++)await tick()
check(reads,1);await tick();check(saveReturned,true)
check(rt.roleRecords.get(f.record.identity.workId).identity.executionId,'replacement')
const persisted=await f.records.get(f.key('roles',f.record.identity.workId))
check(persisted.nativeRetirements[0].helper.delivery.request.id,f.request.id)
check(retirements,[])
gate.resolve();await saving
await Promise.all([...rt.nativeRetirementOperations.values()]);await tick()
check(retirements,[])
check(!!rt.roleRecords.get(f.record.identity.workId).nativeRetirements?.length,true)
check((await f.records.get(f.key('host-restores',commandId))).complete,false)
// Actual original production Host completion, not a fabricated complete field.
await rt.processHostRestores((e,c)=>rt.error(e,c))
for(let n=0;n<100;n++){
 await Promise.allSettled([...rt.maintenance?.values()??[],...rt.nativeRetirementOperations?.values()??[]]);await tick()
 if(!rt.roleRecords.get(f.record.identity.workId).nativeRetirements?.length)break
}
check(retirements,[f.record.sessionId])
check(await f.records.get(f.key('host-restores',commandId)),undefined)
check(await withSnapshot(f.files,s=>f.files.read(s,gitCommandReceiptPath('host-restore:'+commandId))),undefined)
check(rt.roleRecords.get(f.record.identity.workId).nativeRetirements,undefined)
check((await f.records.get(f.key('roles',f.record.identity.workId))).identity.executionId,'replacement')
check(errors,[])
console.log(JSON.stringify({status:'passed',checks,nativeReads:reads,retirements,errors,sdk:evidence()},null,2))
