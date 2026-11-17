// Production Git authority/runtime/tools and installed SDK. Controlled native events.
import assert from 'node:assert/strict'
import {hash,evidence} from './test-support/dsh-sdk-runtime.mjs'
import {Repository,put,head} from './test-support/controlled-git/repository.mjs'
const {FrameworkRoleRuntime}=await import('../src/framework/role-runtime.ts')
const {GitFiles,withSnapshot,FilesOutcomeUnknownError}=await import('../src/framework/transactions.ts')
const {GitAuthorityStore,SessionGitOperations}=await import('../src/framework/git-authority.ts')
const {FrameworkTransactions}=await import('../src/framework/command-transactions.ts')
const {DurableObservationStore}=await import('../src/framework/observation-store.ts')
const {ExecutionObservations}=await import('../src/framework/execution-observation.ts')
const {installFrameworkRoleTools}=await import('../src/framework/role-tools.ts')
const {GitConflictError}=await import('../src/experimental/private-git/github.ts')
const {GitCommitOutcomeUnknownError}=await import('../src/experimental/private-git/contracts.ts')
const {createObservation}=await import('../src/framework/recovery.ts')
const fixed=process.env.DSS_EXPECT_FIXED!=='0';let checks=0
const check=(a,b)=>{assert.deepEqual(a,b);checks++},clone=structuredClone
async function fixture(role='Helper'){
 const repo=new Repository();head(repo);const originalCommit=repo.commitPrepared.bind(repo);let before,loseAck=false
 repo.commitPrepared=async(s,c,m,o)=>{await before?.(s,c,m,o);if(repo.head!==o.expectedHead&&!repo.accepted.has(o.id))throw new GitConflictError();const r=await originalCommit(s,c,m,o);if(loseAck){loseAck=false;repo.resolution={status:'unknown'};throw new GitCommitOutcomeUnknownError(o)}return r};const files=new GitFiles(repo,new SessionGitOperations()),records=new GitAuthorityStore(files,'runtime-lifecycle'),prefix='framework-runtime/'+hash('test')+'/'
 const rt=Object.create(FrameworkRoleRuntime.prototype),request={id:'original-wake',role,reason:'helper',sources:[],context:{facts:'original accepted input'}},record={identity:{role,workId:JSON.stringify([role,null,null,null]),executionId:'original-execution'},sessionId:'original-native-session',generation:1,lastWake:request,delivery:{request,messageId:'original-input',confirmed:true}}
 Object.assign(rt,{files,records,transactions:new FrameworkTransactions(files,records,'test'),config:{scope:'test',mode:'git',member:'A',primary:true},prefix,roleRecords:new Map([[record.identity.workId,record]]),roleBases:new Map([[record.identity.workId,clone(record)]]),roleWrites:new Map(),roleWriteOwners:new Map(),wakeWrites:new Map(),wakeWriteOwners:new Map(),wakeConsumptions:new Map(),publishedHelperSignals:new Set(),observationRecordWrites:new Map(),safetyRestoreWrites:new Map(),restoreWriteOwners:new Map(),safetyEpisodes:new Map(),safetyReplayed:new Set(),safetySettlements:new Map(),resolvedSafetyFaultIds:new Set(),environment:{},conversation:{attachments:{},foregroundRoot:'foreground/git/test'},controls:{execution:async()=>false},workOperations:new Map(),closed:false})
 rt.continueNativeRetirements=()=>{};rt.localWakeAdmissions=new Map();rt.admissionObservationVersion=0;rt.reportedAdmissionDiagnostics=new Set();const events=[],actual={inbox:{nextTurn:[],nextStep:[]},id:'actual-original-agent',session:{id:record.sessionId,header:{},inheritedEventCount:0,snapshotEvents:()=>clone(events)}}
 const owned={actualAgent:actual,sessionId:record.sessionId,observe:()=>({state:'running'}),subscribe:()=>()=>{},subscribeProgress:()=>()=>{},getMessages:()=>events.filter(e=>e.type==='tool/call').map(e=>({role:'assistant',content:[{type:'tool-call',id:e.data.callId,name:e.data.name,arguments:e.data.arguments}]}))}
 rt.native={get:()=>owned};rt.ctx={agents:{get:()=>undefined},sessions:{get:id=>id===record.sessionId?actual.session:undefined,flush:async()=>{}},get:n=>n==='sessionPersistence'?{}:undefined};rt.observationStore=new DurableObservationStore(records,'test');await records.set(prefix+'roles/'+hash(record.identity.workId),record)
 const add=(type,data,extra={})=>{const e={type,data,seq:events.length,time:1,...extra};events.push(e);return e}
 const input=(id='original-input',text='original')=>add('user/message',{id,role:'user',content:[{type:'text',text}],source:{kind:'deepseek-servant'}},{surfaceOp:'append'})
 const call=(id,name,args={})=>add('tool/call',{callId:id,name,arguments:JSON.stringify(args),turn:1,step:0})
 const result=(id,text='{}')=>add('tool/result',{message:{id:'result-'+id,role:'tool',source:{kind:'tool',callId:id},toolCallId:id,isError:false,content:[{type:'text',text}]},turn:1,step:0},{surfaceOp:'append'})
 const key=(kind,id)=>prefix+kind+'/'+hash(id)
 const consume=()=>rt.consumeGitRuntimeRecords?.(rt.roleRecords.get(record.identity.workId),events)
 const addWake=async(extra={})=>{const row={request,delivered:true,nativeOwner:rt.gitRuntimeOwner?.(record),nativeInputId:'original-input',...extra},k=key('wakes',row.request.id);await rt.updateWake(k,()=>row);return{k,row}}
 return{repo,files,records,rt,record,request,events,actual,owned,add,input,call,result,key,consume,addWake,setBefore:fn=>before=fn,loseAck:()=>loseAck=true}
}

export {fixture as gitFixture}
