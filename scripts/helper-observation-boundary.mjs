// Actual SDK-backed storage and production read boundary. Controlled pending
// write; not an end-to-end native admission or model execution claim.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { evidence, hash } from './test-support/dsh-sdk-runtime.mjs'
import { openDshStorageFixture } from './test-support/dsh-sdk-storage.mjs'
const {FrameworkRoleRuntime}=await import('../src/framework/role-runtime.ts')
const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {JsonStorageBackend}=await import('@deepseek-ai/dsh-storage-json')
const recovery=await import('../src/framework/recovery.ts')
const {FrameworkSafetyNet}=await import('../src/framework/safety-net.ts')
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}}
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'helper-boundary-')),prefix='framework-runtime/'+hash('boundary')+'/'
const identity={role:'Helper',workId:'helper',executionId:'helper-original'},key=prefix+'observations/'+hash('unrelated-observation')
const entered=defer(),release=defer(),originalOpen=JsonStorageBackend.prototype.openUnit
JsonStorageBackend.prototype.openUnit=async function(...args){const unit=await originalOpen.apply(this,args);if(args[0].name==='record'){const put=unit.putRecord.bind(unit);unit.putRecord=async(table,k,value)=>{if(k===key){entered.resolve();await release.promise}return put(table,k,value)}}return unit}
let sdk,files,pending,reading
try {
 sdk=await openDshStorageFixture(path.join(dir,'records'),path.join(dir,'locator'));files=new PhysicalLocalFiles(path.join(dir,'files'))
 const rt=Object.assign(Object.create(FrameworkRoleRuntime.prototype),{files,records:sdk.adapter,prefix,observationRecordWrites:new Map()})
 pending=sdk.adapter.set(key,{pending:{action:{identity:{role:'Worker',workId:'unrelated-worker',executionId:'other'}}},complete:true});rt.observationRecordWrites.set(key,{identity:{role:'Worker',workId:'unrelated-worker',executionId:'other'},promise:pending})
 await entered.promise
 let completed=false
 // This is the exact read selected at stopped-role admission in each tree.
 const specialized=typeof rt.admissionObservationActions==='function'
 reading=(specialized?rt.admissionObservationActions(identity):rt.records.list(prefix+'observations/')).then(()=>{completed=true})
 await new Promise(r=>setTimeout(r,40));const completedBeforeUnrelatedWrite=completed
 release.resolve();await pending;await reading
 assert.equal(completedBeforeUnrelatedWrite,specialized)
 let state=recovery.createObservation(identity,0),actions=[]
 for(const time of [299999,300000,599999,600000,2399999,2400000]){const r=recovery.dueObservation(state,time);state=r.state;if(r.action)actions.push({time,kind:r.action.kind})}
 assert.deepEqual(actions,[{time:300000,kind:'probe-helper'},{time:600000,kind:'warn-helper'},{time:2400000,kind:'restore-helper'}])
 assert.deepEqual(recovery.recordProgress(state,'connection-heartbeat',2500000),state)
 assert.equal(recovery.dueObservation(recovery.createObservation({...identity,role:'Foreground'},0),9999999).action,undefined)
 const net=new FrameworkSafetyNet('test'),context={mode:'local',scope:'boundary',source:'helper-review'}
 const f=net.capture(new Error('fault'),context,net.begin());net.failed(f.faultId,'attempt-one','not repaired',false);assert.equal(net.presentation(f.faultId).state,'repairing')
 net.failed(f.faultId,'attempt-two','remaining actual problem',true);assert.equal(net.presentation(f.faultId).state,'visible');net.resolved(f.faultId);assert.equal(net.presentation(f.faultId),undefined)
 console.log(JSON.stringify({status:'passed',completedBeforeUnrelatedWrite,completedAfterUnrelatedWrite:completed,specializedStoppedAdmissionRead:specialized,helperMechanicalActions:actions,heartbeatNotProgress:true,foregroundExcluded:true,explicitSecondDecisionPreserved:true,limits:'Production stopped-admission read boundary and pure observation/SafetyNet functions; no full native admission, live model, Windows or online Git claim.',...evidence()},null,2))
}finally{release.resolve();await pending;await reading;await files?.close();await sdk?.close();JsonStorageBackend.prototype.openUnit=originalOpen;await fs.rm(dir,{recursive:true,force:true})}
