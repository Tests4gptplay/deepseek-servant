// Actual isolated DSH SDK and production Local service, controlled model.
import fs from 'node:fs/promises';
const {fixture,check,until,mark,results}=await import('./helper-service-sdk.mjs');
for(const role of ['Planner','Organizer','Worker','Recorder']) {
 let f;
 try {
  f=await fixture('zero-matrix-'+role);
  const config=async(n,id)=>f.service.configure({mode:'local',commandId:id,settings:{...f.service.config('local').settings,workerSeats:n},changedFields:['workerSeats']});
  if(['Planner','Organizer'].includes(role)) await config(0,'initial-zero');
  const dir=f.dir+'/business/tasks';await fs.mkdir(dir,{recursive:true});await fs.writeFile(dir+'/matrix_'+role+(role==='Organizer'?'_O':'_P')+'.md','# Matrix objective\nKeep this controlled task in progress.\n');
  const live=()=>[...f.rt.roleRecords.values()].find(r=>r.identity.role===role&&f.model.waiting.has(r.sessionId));
  if(['Planner','Organizer'].includes(role)) {
   await until('Queued '+role+' while zero',async()=> (await f.active.connection.records.list(f.prefix+'wakes/')).some(r=>r.value.request?.role===role));
   check(role+' not running at zero',f.model.waiting.size,0);await config(1,'enable');
  } else {
   const planner=await until('Planner produces '+role,()=>[...f.rt.roleRecords.values()].find(r=>r.identity.role==='Planner'&&f.model.waiting.has(r.sessionId)));
   if(role==='Worker') {
    const snapshot=results.get(planner.sessionId);check('Planner real claim snapshot',!!snapshot?.snapshotId,true);
    f.model.command(planner.sessionId,{name:'dss_worker_assign',input:{snapshotId:snapshot.snapshotId,childId:'matrix-worker',contract:'Keep controlled Worker in progress.',decision:'Actual Worker matrix'},callId:'matrix-assign'});
   } else {
    await f.service.taskControl({mode:'local',taskId:planner.identity.taskId,commandId:'matrix-cancel-to-recorder',intent:'cancelled'});
   }
  }
  const original=await until('Actual '+role+' native model running',live);
  await config(0,'disable');
  check(role+' no background model after zero',f.model.waiting.size,0);
  check(role+' original owned execution stopped',f.rt.roleRecords.get(original.identity.workId)?.stopped,true);
  const foregroundReply=async(id)=>{
   await until('Prior foreground retired '+id,()=>{const r=[...f.rt.roleRecords.values()].find(x=>x.identity.role==='Foreground');return !r||r.stopped||r.released});
   const prior=[...f.rt.roleRecords.values()].find(x=>x.identity.role==='Foreground')?.sessionId;
   const before=new Set((await f.rt.conversation.page(100)).messages.map(m=>m.id));
   await f.service.send({mode:'local',collaborationId:'po-native',id,createdAt:new Date().toISOString(),text:'Reply normally while background disabled.',recipient:'ai',device:'isolated'});
   const owner=await until('New foreground owner '+id,()=>[...f.rt.roleRecords.values()].find(x=>x.identity.role==='Foreground'&&x.sessionId!==prior));
   const reply='reply-'+owner.sessionId;check('Exact reply was not pre-existing '+id,before.has(reply),false);
   await until('Exact new visible response '+id,async()=> (await f.rt.conversation.page(100)).messages.some(m=>m.id===reply&&m.role==='assistant'&&m.text==='Request arranged.'));
  };
  await foregroundReply('front-'+role);
  await config(1,'reenable');await until(role+' resumed',live);
  await config(0,'stop-before-restart');await f.close();f=await fixture('zero-matrix-'+role,true);
  check(role+' restart zero preserved',f.service.config('local').settings.workerSeats,0);
  await foregroundReply('restart-front-'+role);
  check(role+' no background after restart',f.model.waiting.size,0);
  mark('matrix-confirmed',{role,mode:'local',zeroStops:true,positiveResumes:true,foregroundPublished:true,restartOff:true});
 }finally{await f?.close()}
}
