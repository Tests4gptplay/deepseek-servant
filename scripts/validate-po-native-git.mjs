// Full FrameworkRoleRuntime/Host + real SDK/tools/JSONL/Cleaner.
// Git transport is explicitly controlled (no remote network or Service login claim).
process.env.DSS_PO_NATIVE_HARNESS='1'
const {fixture,Model,trace,checks,mark,check,until,hash,tool,results,faults,missing,root,evidence}=await import('./validate-po-native-responsibility.mjs')
const fs=await import('node:fs/promises'),path=await import('node:path')
const {FrameworkRoleRuntime}=await import('../src/framework/role-runtime.ts')
const {GitFiles}=await import('../src/framework/transactions.ts'),{GitAuthorityStore,SessionGitOperations}=await import('../src/framework/git-authority.ts')
const {Repository,put,head}=await import('./test-support/controlled-git/repository.mjs'),{GitConflictError}=await import('../src/experimental/private-git/github.ts')
const {sessionDirectory}=await import('../src/native-cleaner/jsonl-adapter.mjs')
class GitModel extends Model{
 nextControl;controls=new Map();done=new Set()
 async *stream(o){
  if(o.tools.some(t=>t.name==='dss_task_restore')){
   if(this.nextControl){const q=this.nextControl;this.nextControl=undefined;this.controls.set(o.sessionId,q);yield*tool('dss_snapshot',{taskId:q.taskId},'view-'+q.command);return}
   const q=this.controls.get(o.sessionId)
   if(q){this.controls.delete(o.sessionId);this.done.add(o.sessionId);const v=results.get(o.sessionId);yield*tool('dss_record',{snapshotId:v.snapshotId,path:v.taskControlPath,append:false,text:JSON.stringify({taskId:q.taskId,intent:q.intent,...q.lifecycleId?{lifecycleId:q.lifecycleId}:{}})},q.command);return}
   yield{type:'text-delta',index:0,text:'Actual control submitted.'};yield{type:'finish',reason:'stop'};return
  }
  yield*super.stream(o)
 }
}
let f,rt,repo
try{
 f=await fixture('git-sdk');await f.service.participation({mode:'local',enabled:false});const model=new GitModel();f.sdk.ctx.llm.registerAdapter(['git-wire'],model)
 repo=new Repository();head(repo);const commit=repo.commitPrepared.bind(repo)
 repo.commitPrepared=async(s,changes,message,operation,...rest)=>{if(s.head!==repo.head&&!repo.accepted.has(operation.id)){mark('git-head-conflict',{expected:s.head,current:repo.head});throw new GitConflictError()}const result=await commit(s,changes,message,operation,...rest);if(!result.replay){for(const c of changes)if(c.deleteTree)for(const p of [...repo.bodies.keys()])if(p.startsWith(c.path+'/'))repo.bodies.delete(p);repo.history.set(repo.head,new Map(repo.bodies))}return result}
 const files=new GitFiles(repo,new SessionGitOperations()),records=new GitAuthorityStore(files,'po-git-private'),scope='po-git-private'
 rt=new FrameworkRoleRuntime(f.sdk.ctx,files,records,{scope,mode:'git',member:'Evidence',primary:true,workspace:path.join(f.dir,'workspace'),workerSeats:1,collaborationId:'po-git',instanceUUID:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',foreground:{provider:'git-wire',model:'controlled'},background:{provider:'git-wire',model:'controlled'}},{members:()=>['Evidence'],resources:()=>[],heartbeat:async()=>{},error:(e,c)=>{mark('git-runtime-error',{error:String(e),context:c});return true}})
 await rt.start();const prefix='framework-runtime/'+hash(scope)+'/',row=r=>records.get(prefix+'roles/'+hash(r.identity.workId))
 async function control(r,intent,command){model.nextControl={taskId:r.identity.taskId,lifecycleId:r.identity.lifecycleId,intent,command};await rt.conversation.send('user-'+command,{id:command,createdAt:new Date().toISOString(),role:'user',participantId:'Evidence',username:'Evidence',recipient:'ai',text:'Explicit isolated '+intent+' request for '+r.identity.taskId},{})
  await until('actual registered Git Foreground control result',()=>trace.find(e=>e.event==='tool'&&e.type==='tool/result'&&e.data.message.toolCallId===command));const e=trace.find(e=>e.event==='tool'&&e.type==='tool/result'&&e.data.message.toolCallId===command);check(command+' tool succeeded',e.data.message.isError,false)}
 for(const route of ['P','O']){
  put(repo,'tasks/Git'+route+'_'+route+'.md','# Actual isolated Git '+route+' objective\n');head(repo)
  const role=route==='P'?'Planner':'Organizer',old=structuredClone(await until('actual Git '+role,()=>[...rt.roleRecords.values()].find(r=>r.identity.role===role&&model.waiting.has(r.sessionId))))
  const agent=rt.native.get(old.identity.workId).actualAgent;await f.sdk.ctx.sessions.flush(agent.session);const file=path.join(sessionDirectory(path.join(f.dir,'sessions'),agent.session.header),'session.v4.jsonl');const bytes=await fs.readFile(file);check(route+' original nonempty',bytes.length>0,true);await fs.writeFile(path.join(root,route+'-native-before.jsonl'),bytes)
  await control(old,'paused','pause-'+route);await until('actual Git stopped',()=>rt.roleRecords.get(old.identity.workId)?.stopped);check(route+' actual owned native stopped',rt.native.get(old.identity.workId),undefined)
  if(process.env.DSS_PO_GIT_FAILURE==='1')faults.set(old.sessionId,{error:Error('CONTROLLED Git journal acceptance failure')})
  await control(old,'running','resume-'+route);let next=structuredClone(await until('actual Git replacement',()=>{const r=rt.roleRecords.get(old.identity.workId);return r?.sessionId!==old.sessionId&&model.waiting.has(r.sessionId)?r:undefined}))
  if(process.env.DSS_PO_GIT_FAILURE==='1'){await until('Git exact pending remains',async()=>!!(await row(next))?.nativeRetirements?.some(x=>x.sessionId===old.sessionId));check(route+' Git failed original remains',await missing(file),false);await control(next,'paused','second-pause-'+route);await until('Git second actual stop',()=>rt.roleRecords.get(next.identity.workId)?.stopped);faults.delete(old.sessionId);const previous=next;await control(previous,'running','second-resume-'+route);next=structuredClone(await until('Git after failure new exact',()=>{const r=rt.roleRecords.get(previous.identity.workId);return r?.sessionId!==previous.sessionId&&model.waiting.has(r.sessionId)?r:undefined}))}
  await until('exact Git pending clear',async()=>!(await row(next))?.nativeRetirements?.length);await f.sdk.ctx.get('nativeSessionCleaner').drain();check(route+(process.env.DSS_PO_EXPECT_RETIREMENT==='0'?' original old native retained':' old native deleted'),await missing(file),process.env.DSS_PO_EXPECT_RETIREMENT!=='0');check(route+' same workId',old.identity.workId,next.identity.workId);mark('git-replacement',{old,next,file,originalSha256:hash(bytes)})
 }
}catch(e){process.exitCode=1;mark('failure',{error:String(e),stack:e.stack})}
finally{try{await rt?.dispose();await Promise.allSettled(rt?.nativeRetirementOperations?.values()??[]);await f?.close()}catch(e){process.exitCode=1;mark('close-failure',{error:String(e)})}await fs.writeFile(path.join(root,'result-git.json'),JSON.stringify({checks,trace,sdk:evidence()},null,2));await fs.writeFile(path.join(root,'repo.json'),JSON.stringify({head:repo?.head,files:[...repo?.bodies??[]],commits:repo?.calls},null,2));await fs.copyFile(new URL(import.meta.url),path.join(root,'executed-git.mjs'))}
