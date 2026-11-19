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
 await until('Helper starts despite zero seats',()=>[...f.rt.roleRecords.values()].find(r=>r.identity.role==='Helper'&&f.model.waiting.has(r.sessionId)));
 mark('confirmed',{zeroStillRunsHelper:true,zeroStillRunsForeground:true});
 for(const id of f.model.waiting.keys()) f.model.command(id,'idle');
}finally{await f?.close()}
