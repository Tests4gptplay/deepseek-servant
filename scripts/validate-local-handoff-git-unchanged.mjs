import assert from 'node:assert/strict'
import {hooks,evidence} from './test-support/dsh-sdk-runtime.mjs'
import {Repository,put,head} from './test-support/controlled-git/repository.mjs'
const {FrameworkTransactions}=await import('../src/framework/command-transactions.ts')
const {GitFiles}=await import('../src/framework/transactions.ts')
const {SessionGitOperations,GitAuthorityStore}=await import('../src/framework/git-authority.ts')
const {FrameworkHostLoop}=await import('../src/framework/host-loop.ts')
const repo=new Repository();put(repo,'tasks/test_P.md','One task');head(repo)
const files=new GitFiles(repo,new SessionGitOperations()),storage=new GitAuthorityStore(files,'git-handoff')
const wakes=[],errors=[],loop=new FrameworkHostLoop(files,new FrameworkTransactions(files,storage,'git-handoff'),storage,{member:'owner',primary:true,scope:'git-handoff',instanceUUID:'20000000-0000-4000-8000-000000000002'},()=>['owner'],{startup:async()=>{},observe:async()=>{},executing:()=>false,wake:async w=>{wakes.push(w);return true},error:e=>errors.push(e)})
try{await loop.start();await loop.firstPoll;assert.equal(wakes.length,0);await loop.poll();assert.equal(wakes.filter(w=>w.role==='Planner').length,1);assert.equal(errors.length,0);console.log(JSON.stringify({passed:true,firstPollWakes:0,secondPollPlannerWakes:1,commits:repo.calls.length,...evidence()},null,2))}finally{await loop.stop();hooks.deregister()}
