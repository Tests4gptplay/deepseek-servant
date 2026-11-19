// Actual isolated DSH SDK/service; controlled in-process model, no user model.
const {fixture,check,until,mark}=await import('./helper-service-sdk.mjs');let f;
const {DshAgentGateway}=await import('../src/adapters/dsh/agents.ts');const orig=DshAgentGateway.prototype.create;DshAgentGateway.prototype.create=async function(...a){try{return await orig.apply(this,a)}catch(e){console.error('GATEWAY_STACK',e.stack);throw e}};
try {
 f=await fixture('worker-zero-baseline');
 await f.service.configure({mode:'local',commandId:'set-zero',settings:{...f.service.config('local').settings,workerSeats:0},changedFields:['workerSeats']});
 check('stored zero',f.service.config('local').settings.workerSeats,0);
 check('runtime still registered',!!f.service.running.get('local'),true);
 f.model.nextForeground={name:'dss_help',input:{facts:'Controlled zero-seat baseline: examine own isolated task.'}};
 await f.service.send({mode:'local',collaborationId:'po-native',id:'zero-foreground',createdAt:new Date().toISOString(),text:'Request helper for baseline',recipient:'ai',device:'isolated'});
 await until('Foreground finishes at zero',()=>[...f.rt.roleRecords.values()].find(r=>r.identity.role==='Foreground'&&r.completedRound));
 check('No background model at zero',f.model.waiting.size,0);
 await f.service.configure({mode:'local',commandId:'enable',settings:{...f.service.config('local').settings,workerSeats:1},changedFields:['workerSeats']});
 await until('Queued Helper starts after enable',()=>[...f.rt.roleRecords.values()].find(r=>r.identity.role==='Helper'&&f.model.waiting.has(r.sessionId)));
 const stop=f.rt.stopOwnedRecord.bind(f.rt);let fail=true;
 f.rt.stopOwnedRecord=async(...args)=>fail?(fail=false,{status:'unconfirmed',reason:'Controlled first stop failure',jobs:[]}):stop(...args);
 let rejected=false;try { await f.service.configure({mode:'local',commandId:'disable-failure',settings:{...f.service.config('local').settings,workerSeats:0},changedFields:['workerSeats']}); } catch {rejected=true}
 check('Unconfirmed stop is not reported success',rejected,true);
 await f.service.configure({mode:'local',commandId:'disable-retry',settings:{...f.service.config('local').settings,workerSeats:0},changedFields:['workerSeats']});
 f.rt.stopOwnedRecord=stop;

 check('Background model stopped',f.model.waiting.size,0);
 const before=f.model.calls.length;
 await f.service.send({mode:'local',collaborationId:'po-native',id:'second-foreground',createdAt:new Date().toISOString(),text:'Reply normally',recipient:'ai',device:'isolated'});
 await until('New Foreground reply after stopping background',()=>f.model.calls.length>before&&[...f.rt.roleRecords.values()].some(r=>r.identity.role==='Foreground'&&r.completedRound));
 await f.service.configure({mode:'local',commandId:'reenable',settings:{...f.service.config('local').settings,workerSeats:1},changedFields:['workerSeats']});
 await until('Interrupted Helper resumes after reenable',()=>f.model.waiting.size>0);
 for(const id of f.model.waiting.keys())f.model.command(id,'idle');
 await f.service.configure({mode:'local',commandId:'disable-before-restart',settings:{...f.service.config('local').settings,workerSeats:0},changedFields:['workerSeats']});
 await f.close();f=await fixture('worker-zero-baseline',true);
 check('Restart preserves zero',f.service.config('local').settings.workerSeats,0);
 await f.service.send({mode:'local',collaborationId:'po-native',id:'restart-foreground',createdAt:new Date().toISOString(),text:'Reply after restart',recipient:'ai',device:'isolated'});
 await until('Foreground replies after zero restart',()=>f.model.calls.length>0&&[...f.rt.roleRecords.values()].some(r=>r.identity.role==='Foreground'&&r.completedRound));
 check('No background running after zero restart',f.model.waiting.size,0);
 mark('confirmed',{zeroForeground:true,enableHelper:true,disableHelper:true,foregroundAfterDisable:true});
}finally{await f?.close()}
