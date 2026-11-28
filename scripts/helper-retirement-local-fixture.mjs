// Production runtime prototype, actual SDK storage and PhysicalLocalFiles on Linux.
// Native event input is controlled SDK-format evidence; no model/Windows claim.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {hash,evidence} from './test-support/dsh-sdk-runtime.mjs'
import {openDshStorageFixture} from './test-support/dsh-sdk-storage.mjs'
const {FrameworkRoleRuntime}=await import('../src/framework/role-runtime.ts')
const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {DurableObservationStore}=await import('../src/framework/observation-store.ts')
const {installFrameworkRoleTools}=await import('../src/framework/role-tools.ts')
const jsonl=await import('@deepseek-ai/dsh-session-persistence-jsonl')
const {SESSION_FORMAT_VERSION}=await import('@deepseek-ai/dsh-session')
const {DshSessionReader}=await import('../src/adapters/dsh/sessions.ts')
const {ExecutionObservations}=await import('../src/framework/execution-observation.ts')
const {createObservation}=await import('../src/framework/recovery.ts')
const {GitFiles}=await import('../src/framework/transactions.ts')
const {GitAuthorityStore,SessionGitOperations}=await import('../src/framework/git-authority.ts')
const {Repository,put,head}=await import('./test-support/controlled-git/repository.mjs')
const {paths}=await import('../src/framework/task-files.ts')
let checks=0;const check=(a,b)=>{assert.deepEqual(a,b);checks++}
const clone=v=>structuredClone(v),tick=()=>new Promise(setImmediate)
const wakeRequest=(role='Helper',id='wake')=>({id,role,reason:'helper',sources:[],context:{facts:'original accepted input'}})
async function fixture(dir,role='Helper',reopen=false){
 const sdk=await openDshStorageFixture(path.join(dir,'records'),path.join(dir,'locator')),files=new PhysicalLocalFiles(path.join(dir,'files')),prefix='framework-runtime/'+hash('test')+'/'
 const rt=Object.create(FrameworkRoleRuntime.prototype),record={identity:{role,workId:JSON.stringify([role,null,null,null]),executionId:'original-execution'},sessionId:'original-session-not-derived-from-execution',generation:1},request=wakeRequest(role)
 record.delivery={request,messageId:'native-input',confirmed:true};record.lastWake=request
 const values={files,records:sdk.adapter,config:{scope:'test',mode:'local',member:'A'},prefix,roleRecords:new Map(),roleWrites:new Map(),roleWriteOwners:new Map(),wakeWrites:new Map(),publishedHelperSignals:new Set(),wakeWriteOwners:new Map(),wakeConsumptions:new Map(),observationRecordWrites:new Map(),safetyRestoreWrites:new Map(),restoreWriteOwners:new Map(),safetyEpisodes:new Map(),safetyReplayed:new Set(),safetySettlements:new Map(),resolvedSafetyFaultIds:new Set(),environment:{},conversation:{attachments:{},foregroundRoot:'foreground/local/test'},controls:{execution:async()=>false},workOperations:new Map(),closed:false}
 Object.assign(rt,values);rt.localWakeAdmissions=new Map();rt.admissionObservationVersion=0;rt.reportedAdmissionDiagnostics=new Set();rt.observationStore=new DurableObservationStore(sdk.adapter,'test')
 const events=[],actual={id:'actual-agent-not-execution',session:{id:record.sessionId,header:{},inheritedEventCount:0,snapshotEvents:()=>clone(events)}}
 const owned={actualAgent:actual,sessionId:record.sessionId,observe:()=>({state:'running'}),subscribe:()=>()=>{},subscribeProgress:()=>()=>{},getMessages:()=>events.filter(e=>e.type==='tool/call').map(e=>({role:'assistant',content:[{type:'tool-call',id:e.data.callId,name:e.data.name,arguments:e.data.arguments}]}))};rt.native={get:()=>owned};rt.ctx={agents:{get:()=>undefined},sessions:{get:id=>id===record.sessionId?actual.session:undefined,flush:async()=>{}},get:n=>n==='sessionPersistence'?{}:undefined}
 if(reopen){for(const row of await sdk.adapter.list(prefix+'roles/'))rt.roleRecords.set(row.value.identity.workId,row.value)}
 else{rt.roleRecords.set(record.identity.workId,record);await sdk.adapter.set(prefix+'roles/'+hash(record.identity.workId),record)}
 const add=(type,data,extra={})=>{const e={type,data,seq:events.length,time:1,...extra};events.push(e);return e}
 const input=(id='native-input')=>add('user/message',{id,role:'user',content:[{type:'text',text:'original'}],source:{kind:'deepseek-servant'}},{surfaceOp:'append'})
 const call=(id='restore-call',name='dss_restore')=>add('tool/call',{callId:id,name,arguments:'{}',turn:1,step:0})
 const result=(id='restore-call',isError=false,text='{}')=>add('tool/result',{message:{id:'result-'+id+'-'+events.length,role:'tool',source:{kind:'tool',callId:id},toolCallId:id,isError,content:[{type:'text',text}]},turn:1,step:0},{surfaceOp:'append'})
 const closeTurn=()=>add('turn/end',{turn:1,reason:{kind:'completed'}})
 const owner=()=>rt.localRuntimeOwner(record),key=(kind,id)=>prefix+kind+'/'+hash(id)
 const addWake=async(id='wake',extra={})=>{const k=key('wakes',id),nativeOwner=await rt.linkLocalRuntimeRecord?.(record,k,'wake');const row={request:wakeRequest(role,id),delivered:true,nativeOwner,nativeInputId:'native-input',...extra};await rt.updateWake(k,()=>row);return{k,row}}
 return{sdk,rt,files,prefix,record,events,actual,owned,add,input,call,result,closeTurn,owner,key,addWake,async close(){await files.close();await sdk.close()}}
}

export {fixture as localFixture}
