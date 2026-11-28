import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as deps from './test-support/dsh-sdk-runtime.mjs'
import { Repository, head } from './test-support/controlled-git/repository.mjs'
const { gitFixture } = await import('./helper-retirement-git-fixture.mjs')
const { FrameworkManualCleanup } = await import('../src/framework/manual-cleanup.ts')
const { Context } = await import('@deepseek-ai/cordis')
const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
const { createScope } = await import('@deepseek-ai/dsh-scope')
const { PhysicalLocalFiles } = await import('../src/framework/physical-local-files.ts')
const { GitFiles, withSnapshot } = await import('../src/framework/transactions.ts')
const { GitAuthorityStore, SessionGitOperations } = await import('../src/framework/git-authority.ts')
const { FrameworkTransactions } = await import('../src/framework/command-transactions.ts')
const { installFrameworkRoleTools } = await import('../src/framework/role-tools.ts')
const { helperDebugPath } = await import('../src/framework/helper-debug-path.ts')
const { hostRecoveryDebugPath, hostRecoverySignalPath, hostRecoverySignalRecordPath } = await import('../src/framework/recovery-debug-record.ts')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dss-task-debug-'))
let checks=0
const check=(a,b)=>{assert.deepEqual(a,b);checks++}
const cases=[]
try {
 for (const mode of ['local','git']) {
  const repo=mode==='git'?new Repository():undefined
  if(repo)head(repo)
  const files=repo?new GitFiles(repo,new SessionGitOperations()):new PhysicalLocalFiles(path.join(root,mode))
  const states=new Map(), records=repo?new GitAuthorityStore(files,'runtime-lifecycle'):{get:async k=>states.get(k),set:async(k,v)=>states.set(k,structuredClone(v))}
  const tx=new FrameworkTransactions(files,records,'debug-test')
  const ctx=new Context();new SystemPrompt(ctx,{});new ToolRuntime(ctx)
  const scopes=[], errors=[]
  ctx.provide('sessions',{flush:async()=>{}})
  const read=p=>withSnapshot(files,s=>files.read(s,p))
  const signals=()=>withSnapshot(files,async s=>(await files.list(s,'state/')).map(item=>item.path).filter(p=>p.startsWith('state/Foreground_Helper_')))
  async function role(name) {
   const events=[], agent={id:mode+'-'+name,session:{snapshotEvents:()=>events}}, scope=createScope(ctx,agent);scopes.push(scope)
   let i=0
   installFrameworkRoleTools(scope.ctx,agent,{role:name,owner:'A',workId:mode+'-'+name,executionId:'e-'+name},{files,transact:tx.run.bind(tx),notifications:async()=>[],onError:e=>errors.push(e),claimNotifications:async()=>{
    // Controlled consumption port; publication and both registered tools are real.
    const found=await signals()
    if(mode==='local')for(const p of found)await files.delete(p)
    else await tx.run('foreground-consume-'+i,{found},{gitReplay:'session-only'},async()=>found.map(path=>({path,content:null})))
    return{signals:found}
   }})
   return async(name,input={})=>{const callId=agent.id+'-'+ ++i;events.push({type:'tool/call',data:{name,callId,arguments:JSON.stringify(input)}});const result=await ctx.tools.execute({name,arguments:input,agent,callId,signal:new AbortController().signal});if(result.isError)throw Error(result.error?.message??JSON.stringify(result));return result.value}
  }
  const helper=await role('Helper'),foreground=await role('Foreground')
  const paths=[helperDebugPath('task-A','2026-11-13'),helperDebugPath('task-B','2026-11-13'),helperDebugPath(undefined,'2026-11-13')]
  const texts=['A actual diagnosis\n','B actual diagnosis\n','Host actual diagnosis\n']
  for(let i=0;i<paths.length;i++) {const v=await helper('dss_snapshot');await helper('dss_record',{snapshotId:v.snapshotId,path:paths[i],text:texts[i],append:true,notifyForeground:true})}
  // A second actual report in A's same dated file keeps its own notification.
  let v=await helper('dss_snapshot');await helper('dss_record',{snapshotId:v.snapshotId,path:paths[0],text:'A actual result\n',append:true,notifyForeground:true})
  const consumed=await foreground('dss_claim');check(consumed.helperReports.length,4);check(new Set(consumed.helperReports.map(x=>x.signal)).size,4)
  for(const item of consumed.helperReports){const actual=await foreground('dss_read',{snapshotId:consumed.snapshotId,path:item.path});check(actual.exists,true);check(actual.text,item.path===paths[0]?texts[0]+'A actual result\n':texts[paths.indexOf(item.path)])}
  check(await signals(),[])
  for(const p of paths)check(typeof await read(p),'string')
  // Accepted legacy references still route to their actual unchanged files.
  for(const [p,text] of [['debug/2026-11-12.md','old daily\n'],['debug/helper-reports/old-report.md','old named\n']]) {v=await helper('dss_snapshot');await helper('dss_record',{snapshotId:v.snapshotId,path:p,text,notifyForeground:true});const c=await foreground('dss_claim');check(c.helperReports.map(x=>x.path),[p]);check((await foreground('dss_read',{snapshotId:c.snapshotId,path:p})).text,text)}
  const physical=hostRecoveryDebugPath(paths[0],'restore-original')
  check(physical.startsWith('debug/helper-debug/tasks/task-A/2026-11-13_Host_Recovery_'),true)
  check(hostRecoverySignalRecordPath(hostRecoverySignalPath('state/tasks/Planner_Recovery_2026-11-13_original',physical)),physical)
  check(hostRecoverySignalRecordPath(hostRecoverySignalPath('state/tasks/Planner_Recovery_2026-11-13_original',paths[0])),paths[0])
  check(hostRecoverySignalPath('state/tasks/Planner_Recovery_2026-11-13_first',paths[0])===hostRecoverySignalPath('state/tasks/Planner_Recovery_2026-11-13_second',paths[0]),false)
  if(mode==='local') {
   const cleanup=new FrameworkManualCleanup(files,tx,{scope:{mode:'local',collaborationId:'audit',assistantId:'audit'},prepare:async()=>{}},{})
   const preview=await cleanup.previewFiles('debug')
   for(const p of paths)check(preview.files.some(item=>item.path===p),true)
   const before=await read(paths[1]);await files.append(paths[1],'later user edit\n')
   const result=await cleanup.clearDebug('user-confirmed-debug',preview,'clear-debug-records')
   check(result.preservedPaths.includes(paths[1]),true)
   check(await read(paths[1]),before+'later user edit\n')
   check(result.deletedPaths.includes(paths[0]),true)
  }
  // Actual Host wake persistence and original signal publication establish the
  // exact supplied directory. Native opening/model scheduling is not emulated.
  const h=await gitFixture(),rt=h.rt,jobs=[]
  if(mode==='local') {
   const store=new Map()
   rt.files=files;rt.records={get:async k=>store.get(k),set:async(k,v)=>store.set(k,structuredClone(v)),list:async prefix=>[...store].filter(([k])=>k.startsWith(prefix)).map(([key,value])=>({key,value}))}
  }
  rt.startMaintenance=(_id,action)=>jobs.push(action())
  for(const taskId of ['actual-A','actual-B',undefined]) {
   const request={id:'debug-wake-'+(taskId??'host'),role:'Helper',reason:'helper',sources:[],context:{facts:'actual authorized diagnostic input',...(taskId?{target:{taskId}}:{})}}
   check(await rt.wake(request),true);await Promise.all(jobs)
   const saved=await rt.records.get(rt.prefix+'wakes/'+deps.hash(request.id))
   const expected=helperDebugPath(taskId,new Date().toISOString().slice(0,10))
   check(saved.request.context.helperDebugPath,expected)
   check(saved.request.context.helperDebugDirectory,expected.slice(0,expected.lastIndexOf('/')+1))
   check(await withSnapshot(rt.files,s=>rt.files.read(s,expected)),'')
   check(await withSnapshot(rt.files,s=>rt.files.read(s,saved.helperSignal)),'')
   check(saved.delivered,undefined);check(saved.signalsConsumed,undefined)
  }
  check(errors,[])
  cases.push({mode,checks,scope:'Actual installed SDK registered DSS report/claim/read tools; real Local files or production GitFiles/transactions with an in-memory repository; consumption port controlled. No model, full Host, remote Git or Windows claim.'})
  for(const scope of scopes)await scope.dispose()
  await files.close?.()
 }
 console.log(JSON.stringify({status:'passed',checks,cases,...deps.evidence()},null,2))
}finally{await fs.rm(root,{recursive:true,force:true});deps.hooks.deregister()}
