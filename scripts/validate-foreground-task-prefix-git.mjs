import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const source = fileURLToPath(new URL('..', import.meta.url))
const { hooks }=await import(path.join(source,'scripts/test-support/dsh-sdk-runtime.mjs'))
const { Repository, head }=await import(path.join(source,'scripts/test-support/controlled-git/repository.mjs'))
const { FrameworkService }=await import(path.join(source,'src/framework/service.ts'))
const { FrameworkConversation }=await import(path.join(source,'src/framework/conversation.ts'))
const { FrameworkTransactions }=await import(path.join(source,'src/framework/command-transactions.ts'))
const { GitFiles, withSnapshot }=await import(path.join(source,'src/framework/transactions.ts'))
const { SessionGitOperations }=await import(path.join(source,'src/framework/git-authority.ts'))
const { FrameworkHostLoop }=await import(path.join(source,'src/framework/host-loop.ts'))
const rows=[]
for(const setting of ['PlainUser','Task_foo']){
 const repo=new Repository();head(repo)
 const files=new GitFiles(repo,new SessionGitOperations()), data=new Map()
 const storage={get:async k=>data.get(k),set:async(k,v)=>data.set(k,v)}
 const tx=new FrameworkTransactions(files,storage,'git-'+setting)
 const conversation=new FrameworkConversation(files,tx,{mode:'git',collaborationId:'shared'})
 const connection={files,scope:'git-'+setting,repository:{identity:{id:'account-member',login:'member'}},identity:{login:'member'},prepareWrite:async()=>{}}
 const service=Object.assign(Object.create(FrameworkService.prototype),{closed:false,modeSending:new Map(),conversationBarriers:new Map(),initializing:Promise.resolve(),access:async()=>({connection,conversation}),config:()=>({settings:{collaborationId:'shared',userName:setting}}),changed(){}})
 const id='msg-'+setting
 await service.send({mode:'git',collaborationId:'shared',id,createdAt:'2026-11-12T12:00:00.123Z',text:'Git '+setting,recipient:'ai',device:'isolated',timezoneOffsetMinutes:0})
 const signals=await withSnapshot(files,s=>files.listDirectory(s,'state/'))
 const wakes=[],host=new FrameworkHostLoop(files,tx,storage,{member:'member',primary:true,scope:'git-'+setting,instanceUUID:'10000000-0000-4000-8000-000000000001'},()=>['member'],{startup:async()=>{},observe:async()=>{},executing:()=>false,wake:async q=>{wakes.push(q);return false},error:e=>{throw e}})
 await Promise.all(await host.runSignalPoll())
 rows.push({setting,signal:signals.map(s=>s.path),wakes:wakes.map(w=>({role:w.role,taskId:w.taskId,source:w.sources[0]?.path})),context:(await conversation.foregroundContext()).messages.map(m=>({id:m.id,text:m.text,participantId:m.participantId})),commits:repo.calls.length})
 assert.equal(wakes[0]?.taskId,undefined)
}
console.log(JSON.stringify(rows,null,2))
