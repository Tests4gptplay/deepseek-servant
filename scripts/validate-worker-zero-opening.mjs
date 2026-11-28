// Actual SDK creation, with a controlled gate before its normal create call.
const {fixture,check,until,mark}=await import('./helper-service-sdk.mjs');let f;
try {
 f=await fixture('zero-opening');const create=f.rt.gateway.create.bind(f.rt.gateway),gate=Promise.withResolvers();let entered=false;
 f.rt.gateway.create=async request=>{if([...f.rt.roleRecords.values()].some(r=>r.sessionId===request.sessionId&&r.identity.role==='Helper')){entered=true;await gate.promise}return create(request)};
 f.model.nextForeground={name:'dss_help',input:{facts:'Controlled opening transition'}};
 await f.service.send({mode:'local',collaborationId:'po-native',id:'open-case',createdAt:new Date().toISOString(),text:'Ask helper',recipient:'ai',device:'isolated'});
 await until('Helper enters actual native acquisition',()=>entered);
 const changing=f.service.configure({mode:'local',commandId:'disable-opening',settings:{...f.service.config('local').settings,workerSeats:0},changedFields:['workerSeats']});
 await until('Zero applied before native create completes',()=>f.rt.config.workerSeats===0);gate.resolve();await changing;
 check('No Helper model launched',f.model.waiting.size,0);
 f.rt.gateway.create=create;
 const before=f.model.calls.length;
 await f.service.send({mode:'local',collaborationId:'po-native',id:'after-opening',createdAt:new Date().toISOString(),text:'Reply normally',recipient:'ai',device:'isolated'});
 await until('Foreground full reply after interrupted acquisition',()=>f.model.calls.length>before&&[...f.rt.roleRecords.values()].some(r=>r.identity.role==='Foreground'&&r.completedRound));
 await f.service.configure({mode:'local',commandId:'enable-opening',settings:{...f.service.config('local').settings,workerSeats:1},changedFields:['workerSeats']});
 await until('Original queued helper resumes',()=>f.model.waiting.size>0);
 for(const id of f.model.waiting.keys())f.model.command(id,'idle');mark('confirmed-opening',{cancelledAcquisition:true,foregroundReplied:true,recoveredOriginal:true});
}finally{await f?.close()}
