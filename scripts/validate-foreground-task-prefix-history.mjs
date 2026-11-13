import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import './test-support/dsh-sdk-runtime.mjs'
import { Repository, put, head } from './test-support/controlled-git/repository.mjs'
const {FrameworkHostLoop}=await import('../src/framework/host-loop.ts')
const {FrameworkRoleRuntime}=await import('../src/framework/role-runtime.ts')
const {PhysicalLocalFiles}=await import('../src/framework/physical-local-files.ts')
const {GitFiles,withSnapshot}=await import('../src/framework/transactions.ts')
const {SessionGitOperations}=await import('../src/framework/git-authority.ts')
const {FrameworkTransactions}=await import('../src/framework/command-transactions.ts')
const {foregroundTaskSignal,parseForegroundTaskSignal}=await import('../src/framework/task-files.ts')
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'dss-prefix-history-'))
const taskId='123e4567-e89b-42d3-a456-426614174000'
const taskPath=foregroundTaskSignal(taskId)
const oldConversation='state/Foreground_Task_foo-GMT0-20261112-120000123-abc123'
const cases=[]
try{
 for(const mode of ['local','git']){
  const repo=mode==='git'?new Repository():undefined
  if(repo){put(repo,taskPath,'');put(repo,oldConversation,'');head(repo)}
  const files=repo?new GitFiles(repo,new SessionGitOperations()):new PhysicalLocalFiles(path.join(scratch,mode))
  if(!repo){await files.replace(taskPath,'');await files.replace(oldConversation,'')}
  const storage={get:async()=>undefined,set:async()=>{}},tx=new FrameworkTransactions(files,storage,mode)
  const wakes=[]
  const host=new FrameworkHostLoop(files,tx,storage,{member:'A',primary:true,scope:mode,instanceUUID:'10000000-0000-4000-8000-000000000001'},()=>['A'],{startup:async()=>{},observe:async()=>{},executing:()=>false,wake:async q=>{wakes.push(q);return false},error:e=>{throw e}})
  await Promise.all(await host.runSignalPoll())
  const selected=wakes.map(w=>({taskId:w.taskId,source:w.sources.map(s=>s.path),taskPath:w.context?.taskPath}))
  assert.deepEqual(selected,[{taskId:undefined,source:[oldConversation],taskPath:undefined},{taskId,source:[taskPath],taskPath:'tasks/'+taskId+'.json'}])
  assert.equal(parseForegroundTaskSignal(taskPath),taskId)
  assert.equal(parseForegroundTaskSignal(oldConversation),undefined)
  cases.push({mode,wakes:selected,remainingSignals:(await withSnapshot(files,s=>files.listDirectory(s,'state/'))).map(r=>r.path)})
  if(mode==='local'){
   const owner={notificationClaims:{old:{sources:[{path:oldConversation,version:'old'}]}}}
   const pending=await FrameworkRoleRuntime.prototype.pendingClaimedForegroundTasks.call({files},owner)
   assert.deepEqual(pending,[])
   cases.at(-1).oldClaimPending=pending
   const task={version:1,taskId,route:'P',sourcePath:'tasks/Original_P.md',owner:'A',status:'complete'}
   await files.replace('tasks/'+taskId+'.json',JSON.stringify(task))
   const taskOwner={notificationClaims:{task:{sources:[{path:taskPath,version:'task'}]}}}
   const taskPending=await FrameworkRoleRuntime.prototype.pendingClaimedForegroundTasks.call({files},taskOwner)
   assert.deepEqual(taskPending.map(r=>({role:r.role,taskId:r.taskId,reason:r.reason})),[{role:'Foreground',taskId,reason:'business-complete'}])
   cases.at(-1).taskClaimPending=taskPending.map(r=>({role:r.role,taskId:r.taskId,reason:r.reason}))
  }
  await files.close?.()
 }
 console.log(JSON.stringify(cases,null,2))
}finally{await fs.rm(scratch,{recursive:true,force:true})}
