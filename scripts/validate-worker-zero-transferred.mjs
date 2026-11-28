// Actual SDK Worker assignment/delivery; controlled pause in existing native
// drain keeps an already-transferred producer alive. Not a natural fault claim.
import fs from 'node:fs/promises';
const {fixture,check,until,mark,results}=await import('./helper-service-sdk.mjs');let f,release;
try{
 f=await fixture('zero-transferred');await fs.mkdir(f.dir+'/business/tasks',{recursive:true});await fs.writeFile(f.dir+'/business/tasks/transferred_P.md','# Transfer test\nAssign a Worker.\n');
 const planner=await until('Planner running',()=>[...f.rt.roleRecords.values()].find(r=>r.identity.role==='Planner'&&f.model.waiting.has(r.sessionId)));
 f.model.command(planner.sessionId,{name:'dss_worker_assign',input:{snapshotId:results.get(planner.sessionId).snapshotId,childId:'transfer-worker',contract:'Return a controlled actual result.',decision:'Transfer boundary'},callId:'transfer-assign'});
 const worker=await until('Worker running',()=>[...f.rt.roleRecords.values()].find(r=>r.identity.role==='Worker'&&f.model.waiting.has(r.sessionId)));
 const stop=f.rt.stopOwnedRecord.bind(f.rt),gate=Promise.withResolvers();release=gate.resolve;let paused=false,zeroStopped=false;
 f.rt.stopOwnedRecord=async(record,...args)=>{
  if(record.identity.executionId===worker.identity.executionId){
   if(!paused&&(f.rt.retiredWorkers?.has(record.identity.executionId)||f.rt.roleRecords.get(record.identity.workId)?.businessTransferred)){paused=true;await gate.promise}
   else if(paused&&f.rt.config.workerSeats===0)zeroStopped=true;
  }
  return stop(record,...args)
 };
 f.model.command(worker.sessionId,{name:'dss_worker_deliver',input:{snapshotId:results.get(worker.sessionId).snapshotId,reply:'Actual controlled Worker delivery.',records:[]},callId:'transfer-deliver'});
 await until('Actual transferred Worker waiting in drain',()=>paused);
 const retained=f.rt.retiredWorkers?.get(worker.identity.executionId)??f.rt.roleRecords.get(worker.identity.workId);
 check('Transferred identity retained',retained?.identity.executionId,worker.identity.executionId);
 check('Producer not yet stopped',retained?.stopped===true,false);
 await f.service.configure({mode:'local',commandId:'zero-transfer',settings:{...f.service.config('local').settings,workerSeats:0},changedFields:['workerSeats']});
 check('Zero explicitly stopped transferred producer',zeroStopped,true);release();
 await until('Transferred producer stop persisted',()=> (f.rt.retiredWorkers?.get(worker.identity.executionId)??f.rt.roleRecords.get(worker.identity.workId))?.stopped===true);
 await f.service.send({mode:'local',collaborationId:'po-native',id:'after-transfer',createdAt:new Date().toISOString(),text:'Reply normally.',recipient:'ai',device:'isolated'});
 await until('Foreground publishes after transferred stop',async()=> (await f.rt.conversation.page(100)).messages.some(m=>m.role==='assistant'&&m.text==='Request arranged.'));
 mark('transferred-confirmed',{actualWorkerAssignAndDeliver:true,controlledDrainPause:true,zeroClosedProducer:true,foregroundPublished:true});
}finally{release?.();await f?.close()}
