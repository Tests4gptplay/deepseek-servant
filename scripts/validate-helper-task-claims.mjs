import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as deps from './test-support/dsh-sdk-runtime.mjs'
import {gitFixture} from './helper-retirement-git-fixture.mjs'
import {localFixture} from './helper-retirement-local-fixture.mjs'
const {FrameworkTransactions}=await import('../src/framework/command-transactions.ts')
const {withSnapshot}=await import('../src/framework/transactions.ts')
const root=await fs.mkdtemp(path.join(os.tmpdir(),'helper-task-claim-'));let checks=0;const check=(a,b)=>{assert.deepEqual(a,b);checks++}
const cases=[]
try {
 for(const mode of ['local','git']) {
  const f=mode==='git'?await gitFixture():await localFixture(path.join(root,mode)),rt=f.rt,records=f.records??f.sdk.adapter,jobs=[]
  rt.transactions??=new FrameworkTransactions(f.files,records,'test');rt.taskNotices=new Map();rt.safetyRequests=new Map();rt.config.primary=true
  rt.safetyReplayed??=new Set();rt.resolvedSafetyFaultIds??=new Set();rt.startMaintenance=(_id,fn)=>jobs.push(fn())
  f.actual.inbox={nextTurn:[],nextStep:[]};f.actual.status='running'
  await f.addWake();f.input()
  const binding=rt.binding(f.record,f.record.delivery.request),services=rt.services()
  f.call('initial-claim','dss_claim');const first=await services.claimNotifications(binding,'initial-claim')
  f.result('initial-claim',...(mode==='local'?[false,JSON.stringify(first)]:[JSON.stringify(first)]))
  const taskIds=['10000000-0000-4000-8000-000000000011','10000000-0000-4000-8000-000000000012']
  const write=async(p,text)=>mode==='local'?f.files.replace(p,text):withSnapshot(f.files,s=>f.files.commit(s,[{path:p,content:text}],'fixture task'))
  const read=p=>withSnapshot(f.files,s=>f.files.read(s,p))
  for(const [i,taskId] of taskIds.entries()) {
   await write('tasks/'+taskId+'.json',JSON.stringify({version:1,taskId,owner:'A',route:'P',status:'running',sourcePath:'tasks/task-'+i+'_P.md'}))
   await write('state/A/'+taskId+'/recovery','')
   await services.helper.request({role:'Planner',taskId,member:'A',owner:'A',workId:'planner-'+i,executionId:'planner-execution-'+i},'Actual request '+taskId,'request-'+i)
  }
  await Promise.all(jobs)
  f.call('later-claim','dss_claim');const claimed=await services.claimNotifications(binding,'later-claim')
  f.result('later-claim',...(mode==='local'?[false,JSON.stringify(claimed)]:[JSON.stringify(claimed)]))
  const later=claimed.helperNotifications.filter(q=>q.id.startsWith('help:request-'))
  check(later.length,2)
  for(const [i,taskId] of taskIds.entries()) {
   const q=later.find(q=>q.context.target.taskId===taskId)
   check(q.id,'help:request-'+i)
   check(q.context.helperDebugPath.startsWith('debug/helper-debug/tasks/'+taskId+'/'),true)
   check(await read(q.context.helperDebugPath),'')
   const wake=await records.get(rt.prefix+'wakes/'+deps.hash(q.id))
   check(wake.delivered,true);check(wake.signalsConsumed,true)
   check(await read(wake.helperSignal),undefined)
   check(await read('state/A/'+taskId+'/recovery'),'')
  }
  check(new Set(later.map(q=>q.context.helperDebugPath)).size,2)
  cases.push({mode,checks,scope:'Actual FrameworkRoleRuntime helper.request, wake publication and claimNotifications with production stores; native inputs/results controlled. No assertion of natural model tool choice.'})
  if(mode==='local')await f.close();else await f.files.close?.()
 }
 console.log(JSON.stringify({status:'passed',checks,cases,...deps.evidence()},null,2))
}finally{await fs.rm(root,{recursive:true,force:true});deps.hooks.deregister()}
