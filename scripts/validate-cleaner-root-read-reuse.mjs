import assert from 'node:assert/strict'
import './test-support/dsh-sdk-runtime.mjs'
import {Repository,put,head} from './test-support/controlled-git/repository.mjs'
const {GitFiles,withSnapshot}=await import('../src/framework/transactions.ts')
const {SessionGitOperations}=await import('../src/framework/git-authority.ts')
const {observeCleanup}=await import('../src/framework/cleaner.ts')
const {paths}=await import('../src/framework/task-files.ts')
const repo=new Repository(),files=new GitFiles(repo,new SessionGitOperations())
const task={version:1,taskId:'10000000-0000-4000-8000-000000000999',route:'P',owner:'A',members:['A'],status:'complete',sourcePath:'tasks/test_P.md'}
put(repo,paths.task(task.taskId),task);put(repo,paths.state('A',task.taskId)+'/Cleaner','');head(repo)
let reads=0;const read=files.read.bind(files);files.read=async(s,p)=>{if(p===paths.task(task.taskId))reads++;return read(s,p)}
const result=await withSnapshot(files,s=>observeCleanup(files,s,task,0))
assert.equal(result.error,undefined);assert.equal(result.status,'delete');assert.equal(result.family.length,1);assert.equal(reads,1)
assert.ok(result.publication.changes.some(c=>c.deleteTree));console.log(JSON.stringify({status:'passed',rootTaskReads:reads,statusResult:result.status,scope:'production observeCleanup/GitFiles, controlled transport; no native Host/model'}));files.operations.close()
