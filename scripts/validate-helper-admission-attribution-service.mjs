// Actual Service/Host/official SDK. Controlled failure of an existing durable
// adapter write, NOT a claimed user incident, and not an invented native fault.
import fs from 'node:fs/promises'
import path from 'node:path'
const {fixture,trace,checks,mark,check,until,hash,root,evidence}=await import('./helper-service-sdk.mjs')
const phase=process.argv[2]??'prepare'
if(!['prepare','confirm','wake-ack'].includes(phase))throw Error('Expected prepare, confirm or wake-ack')
let f,releaseModel,restoreWrite
try{
 f=await fixture()
 async function help(id){f.model.nextForeground={name:'dss_help',input:{facts:'Inspect the actual isolated Host: '+id}};await f.service.send({mode:'local',collaborationId:'po-native',id,createdAt:new Date().toISOString(),text:'Ask Helper for '+id,recipient:'ai',device:'isolated'})}
 await help('original-normal-help')
 const old=await until('original Helper accepted',()=>{const r=[...f.rt.roleRecords.values()].find(r=>r.identity.role==='Helper');return r?.delivery?.confirmed&&f.model.waiting.has(r.sessionId)?structuredClone(r):undefined})
 f.model.command(old.sessionId,'idle')
 const oldKey=f.prefix+'wakes/'+hash(old.delivery.request.id)
 await until('ordinary consumed old Wake retired',async()=>!await f.active.connection.records.get(oldKey))
 await f.service.participation({mode:'local',enabled:false})
 await f.service.participation({mode:'local',enabled:true})
 f.active=f.service.running.get('local');f.rt=f.active.runtime
 const stopped=f.rt.roleRecords.get(old.identity.workId)
 check('original Helper really stopped, not a seeded state',stopped.stopped,true)
 check('normal old Wake remains retired',await f.active.connection.records.get(oldKey),undefined)
 // Hold only controlled model output of the next Helper. Native send/open and
 // its input acceptance are entirely production SDK behavior.
 const originalStream=f.model.stream.bind(f.model),modelBarrier=new Promise(r=>releaseModel=r)
 f.model.stream=async function*(o){if(o.sessionId!==old.sessionId&&o.tools.some(t=>t.name==='dss_restore'))await modelBarrier;yield*originalStream(o)}
 const records=f.active.connection.records,write=records.set.bind(records)
 const failure=Object.assign(new Error('Controlled adapter '+phase+' write failure'),{code:'EIO'})
 let armed=true,hit=false,newRequest,newIdentity
 records.set=async(key,value)=>{
  const role=value?.identity?.role==='Helper'&&value.identity.executionId!==old.identity.executionId
  if(role){newRequest??=value.delivery?.request;newIdentity??=value.identity}
  const selected=phase==='prepare'?role&&!value.delivery?.confirmed
    :phase==='confirm'?role&&value.delivery?.confirmed
    :!!newRequest&&key===f.prefix+'wakes/'+hash(newRequest.id)&&value.delivered===true
  if(armed&&selected){hit=true;mark('controlled-write-failure',{phase,key,request:newRequest,identity:newIdentity,delivery:value.delivery,delivered:value.delivered})
   if(phase==='wake-ack')await write(key,value) // test-only throw after success; not a proven adapter failure mode
   throw failure
  }
  return write(key,value)
 }
 restoreWrite=()=>{armed=false;records.set=write}
 const errors=[],report=f.rt.environment.error
 f.rt.environment.error=(error,origin,safety)=>{errors.push({error,origin,safety});return report(error,origin,safety)}
 await help('replacement-help')
 await until('controlled existing write reached',()=>hit)
 const reported=await until('runQueue preserved actual original Wake identity',()=>errors.find(e=>e.error===failure))
 check('catch names exactly this requested Helper Wake',reported.origin.diagnosticContext.wakeId,newRequest.id)
 check('catch does not invent an execution fault',reported.origin.identity,undefined)
 const ep=await until('actual Service Safety delivery',()=>[...f.rt.safetyEpisodes.values()].find(e=>e.fault.diagnosticContext?.wakeId===newRequest.id))
 await until('Safety attachment settled',()=>!f.rt.safetyRequests.size)
 check('Safety belongs to the new request, never stopped predecessor',ep.helperWakeId,newRequest.id)
 const pending=await records.get(f.prefix+'wakes/'+hash(newRequest.id))
 check('existing new Wake contains actual fault',pending.safetyFaults.some(x=>x.id===ep.fault.id),true)
 check('old consumed Wake not reconstructed for new fault',await records.get(oldKey),undefined)
 const current=f.rt.roleRecords.get(old.identity.workId)
 check('Safety attachment did not replace the delivery owner',current.identity.executionId,phase==='prepare'?old.identity.executionId:newIdentity.executionId)
 check('attachment preserves actual delivered status',pending.delivered===true,phase==='wake-ack')
 if(phase!=='prepare'){
  const session=f.sdk.ctx.sessions.get(current.sessionId),messageId='dss-wake-'+hash(newRequest.id)
  check('actual SDK received exactly one original input',session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.id===messageId).length,1)
 }
 check('no extra diagnostic Helper Wake manufactured',(await records.list(f.prefix+'wakes/')).filter(r=>r.value.request.role==='Helper'&&r.value.request.id!==newRequest.id).length,0)
 restoreWrite();releaseModel()
 // Existing STATE/queue retry, not a new Wake or a new diagnostic handshake.
 await f.rt.runQueue(true,newRequest.id)
 const active=await until('original new request continues',()=>{const r=f.rt.roleRecords.get(old.identity.workId);return r.delivery?.request.id===newRequest.id&&f.model.waiting.has(r.sessionId)?r:undefined})
 const session=f.sdk.ctx.sessions.get(active.sessionId),messageId='dss-wake-'+hash(newRequest.id)
 check('existing retry retains one SDK input',session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.id===messageId).length,1)
 check('original queue does not infer a lost confirmation while native execution is active',active.delivery.confirmed,phase!=='confirm')
 check('original Wake delivery metadata is preserved, not invented',(await records.get(f.prefix+'wakes/'+hash(newRequest.id))).delivered===true,phase!=='confirm')
 const claim=trace.filter(e=>e.event==='tool'&&e.id===active.sessionId&&e.type==='tool/result'&&!e.data.message.isError).find(e=>e.data.message.content?.some(c=>c.type==='text'&&c.text.includes(ep.fault.id)))
 check('actual Helper receives its original Safety diagnostic through existing claim',!!claim,true)
 mark('verified',{phase,checks:checks.length,old:old.identity,current:active.identity,wakeId:newRequest.id})
}catch(error){process.exitCode=1;mark('failure',{phase,error:String(error),stack:error.stack})}
finally{restoreWrite?.();releaseModel?.();if(f)try{await f.close()}catch(error){process.exitCode=1;mark('close-failure',{error:String(error),stack:error.stack})};await fs.writeFile(path.join(root,'result.json'),JSON.stringify({phase,checks,trace,sdk:evidence()},null,2));await fs.copyFile(new URL(import.meta.url),path.join(root,'executed.mjs'))}
