// Actual DSH SDK/native model loop and production Git authority/runtime; controlled
// in-memory Git transport and model. Not a real remote Git or user UI experiment.
const {fixture,check,until,mark}=await import('./helper-service-sdk.mjs');
const {Repository}=await import('./test-support/controlled-git/repository.mjs');
const {GitFiles}=await import('../src/framework/transactions.ts');
const {GitAuthorityStore,SessionGitOperations}=await import('../src/framework/git-authority.ts');
const {FrameworkRoleRuntime}=await import('../src/framework/role-runtime.ts');
let f,rt;
try {
 f=await fixture('zero-git',false,true);
 const files=new GitFiles(new Repository(),new SessionGitOperations());
 const records=new GitAuthorityStore(files,'zero-git');
 const create=()=>new FrameworkRoleRuntime(f.sdk.ctx,files,records,{scope:'zero-git',mode:'git',member:'Evidence',instanceUUID:'00000000-0000-4000-8000-000000000001',primary:true,workspace:f.dir+'/workspace',collaborationId:'po-native',workerSeats:0,foreground:{provider:'isolated-wire',model:'controlled'},background:{provider:'isolated-wire',model:'controlled'}},{members:()=>['Evidence'],resources:()=>[],heartbeat:async()=>{},error:(e)=>console.error('RUNTIME_ERROR',e.stack)});
 rt=create();await rt.start();
 await rt.wake({id:'git-foreground',role:'Foreground',reason:'notification',sources:[]});
 await until('Git Foreground complete at zero',()=>[...rt.roleRecords.values()].some(r=>r.identity.role==='Foreground'&&r.completedRound));
 await rt.wake({id:'git-helper',role:'Helper',reason:'helper',sources:[],context:{facts:'Controlled background request'}});
 check('Git no Helper model at zero',f.model.waiting.size,0);
 await rt.updateWorkerSeats(1);
 await until('Git Helper enabled',()=>f.model.waiting.size>0);
 await rt.updateWorkerSeats(0);
 check('Git Helper stopped',f.model.waiting.size,0);
 const before=f.model.calls.length;
 await rt.wake({id:'git-foreground-two',role:'Foreground',reason:'notification',sources:[]});
 await until('Git Foreground complete after disable',()=>f.model.calls.length>before&&[...rt.roleRecords.values()].some(r=>r.identity.role==='Foreground'&&r.completedRound));
 await rt.updateWorkerSeats(1);
 await until('Git Helper resumes after enable',()=>f.model.waiting.size>0);
 await rt.updateWorkerSeats(0);await rt.dispose();rt=create();await rt.start();
 const restarted=f.model.calls.length;
 await rt.wake({id:'git-foreground-restart',role:'Foreground',reason:'notification',sources:[]});
 await until('Git foreground reply after zero restart',()=>f.model.calls.length>restarted&&[...rt.roleRecords.values()].some(r=>r.identity.role==='Foreground'&&r.completedRound));
 check('No background after Git zero restart',f.model.waiting.size,0);
 const page=await rt.conversation.page(100);
 check('Persisted Foreground reply bodies',page.messages.filter(m=>m.text==='Request arranged.').length>=3,true);
 mark('confirmed-git',{foregroundAtZero:true,helperEnableDisable:true,foregroundAfterDisable:true});
}finally {await rt?.dispose();await f?.close()}
