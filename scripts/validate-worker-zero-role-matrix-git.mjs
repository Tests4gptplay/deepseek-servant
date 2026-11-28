// Production Git runtime + actual DSH SDK/native agents, actual local Git CLI
// object storage and CAS. Transport/model controlled; no GitHub/UI claim.
import path from 'node:path';
const {fixture,check,until,mark,results}=await import('./helper-service-sdk.mjs');
process.env.DSS_AUDIT_SOURCE_ROOT=path.resolve('.');
const {gitFixture}=await import('./test-support/helper-consume-git-fixture.mjs');
const {GitAuthorityStore}=await import('../src/framework/git-authority.ts');
const {FrameworkRoleRuntime}=await import('../src/framework/role-runtime.ts');
const {withSnapshot}=await import('../src/framework/transactions.ts');
const {submitTaskCancellation}=await import('../src/framework/task-cancellation.ts');
const {taskArchiveHostKey}=await import('../src/framework/task-archive.ts');
for(const role of ['Planner','Organizer','Worker','Recorder']) {
 let f,rt,g;
 try {
  f=await fixture('zero-matrix-git-'+role,false,true);g=gitFixture(f.dir+'/repo.git','sha1');
  const scope='matrix-git-'+role,files=g.files,records=new GitAuthorityStore(files,scope),instanceUUID='00000000-0000-4000-8000-000000000001';
  const create=(seats)=>new FrameworkRoleRuntime(f.sdk.ctx,files,records,{scope,mode:'git',member:'Evidence',primary:true,instanceUUID,workspace:f.dir+'/workspace',workerSeats:seats,collaborationId:'po-native',foreground:{provider:'isolated-wire',model:'controlled'},background:{provider:'isolated-wire',model:'controlled'}},{members:()=>['Evidence'],resources:()=>[],heartbeat:async()=>{},error:(e)=>mark('runtime-error',{message:String(e)})});
  rt=create(['Planner','Organizer'].includes(role)?0:1);await rt.start();
  await withSnapshot(files,s=>files.commit(s,[{path:'tasks/matrix_'+role+(role==='Organizer'?'_O':'_P')+'.md',content:'# Matrix objective\nKeep controlled work running.\n'}],'Actual Git task source'));
  const live=()=>[...rt.roleRecords.values()].find(r=>r.identity.role===role&&f.model.waiting.has(r.sessionId));
  if(['Planner','Organizer'].includes(role)) {
   await until('Git queued '+role+' at zero',async()=> (await records.list(rt.prefix+'wakes/')).some(r=>r.value.request?.role===role));
   check(role+' Git no model while zero',f.model.waiting.size,0);await rt.updateWorkerSeats(1);
  } else {
   const planner=await until('Git actual Planner',()=>[...rt.roleRecords.values()].find(r=>r.identity.role==='Planner'&&f.model.waiting.has(r.sessionId)));
   if(role==='Worker') {
    const snapshot=results.get(planner.sessionId);check('Git Planner snapshot',!!snapshot?.snapshotId,true);
    f.model.command(planner.sessionId,{name:'dss_worker_assign',input:{snapshotId:snapshot.snapshotId,childId:'matrix-worker',contract:'Keep controlled Worker running.',decision:'Worker matrix'},callId:'matrix-git-assign'});
   }else {
    await submitTaskCancellation({files,member:'Evidence',commandHostKey:taskArchiveHostKey(records.root,scope,instanceUUID),transact:(id,input,options,build)=>rt.transactions.run(id,input,options,build)},{taskId:planner.identity.taskId},'matrix-git-cancel');
   }
  }
  const original=await until('Git '+role+' native running',live);
  await rt.updateWorkerSeats(0);check(role+' Git all background stopped',f.model.waiting.size,0);
  check(role+' stopped fact',rt.roleRecords.get(original.identity.workId)?.stopped,true);
  await rt.wake({id:'foreground-'+role,role:'Foreground',reason:'notification',sources:[]});
  await until('Git visible reply with '+role+' disabled',async()=> (await rt.conversation.page(100)).messages.some(m=>m.role==='assistant'&&m.text==='Request arranged.'));
  await rt.updateWorkerSeats(1);await until('Git '+role+' resumes',live);
  await rt.updateWorkerSeats(0);await rt.dispose();rt=create(0);await rt.start();
  await rt.wake({id:'restart-front-'+role,role:'Foreground',reason:'notification',sources:[]});
  await until('Git visible reply after restart',async()=> (await rt.conversation.page(100)).messages.filter(m=>m.role==='assistant'&&m.text==='Request arranged.').length>=2);
  check(role+' Git stays disabled after restart',f.model.waiting.size,0);
  mark('matrix-confirmed',{role,mode:'git-real-objects',zeroStops:true,positiveResumes:true,foregroundPublished:true,restartOff:true});
 }catch(e){console.error('MATRIX_FAILURE',e.stack);throw e}finally{await rt?.dispose();await g?.repo.releaseCache();await f?.close()}
}
