// Read-only product inspection through real isolated Service/Host/official SDK.
// Deterministic model decisions only. No failure injection or production edits.
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
const {fixture,trace,checks,mark,check,until,hash,results,missing,root,evidence}=await import('./helper-service-sdk.mjs')
const {DshSessionReader,deriveNativeInputs}=await import('../src/adapters/dsh/sessions.ts')
const {sessionDirectory}=await import('../src/native-cleaner/jsonl-adapter.mjs')
let f,seq=0
const script=await fs.readFile(new URL(import.meta.url),'utf8')
async function help(label){
 f.model.nextForeground={name:'dss_help',input:{facts:'Inspect current isolated host. '+label}}
 await f.service.send({mode:'local',collaborationId:'po-native',id:'normal-host-wake-'+(++seq),createdAt:new Date().toISOString(),text:'Ask Helper to inspect the isolated host: '+label,recipient:'ai',device:'isolated',timezoneOffsetMinutes:0})
 return until('actual Helper claim '+label,()=>{const r=[...f.rt.roleRecords.values()].find(x=>x.identity.role==='Helper');return r?.delivery?.confirmed&&f.model.waiting.has(r.sessionId)?structuredClone(r):undefined})
}
async function command(r,name,input){
 const begin=trace.length
 f.model.command(r.sessionId,{name,input})
 const result=await until('actual '+name+' result',()=>trace.slice(begin).find(e=>e.event==='tool'&&e.id===r.sessionId&&e.type==='tool/result'))
 await until('model ready after '+name,()=>f.model.waiting.has(r.sessionId))
 check(name+' succeeds '+seq++,result.data.message.isError,false)
 const calls=trace.slice(begin).filter(e=>e.event==='tool'&&e.id===r.sessionId)
 mark('observed-command',{name,events:calls})
 return calls.find(e=>e.type==='tool/call').data.callId
}
async function idle(r){f.model.command(r.sessionId,'idle');await until('actual Helper settled idle',()=>{const c=f.rt.roleRecords.get(r.identity.workId);return f.rt.native.get(r.identity.workId)?.observe().state==='idle'&&c?.gitSettledWakeId===c.delivery?.request.id})}
async function observe(label,old){
 const rows=await f.active.connection.records.list(f.prefix+'wakes/'),restores=await f.active.connection.records.list(f.prefix+'host-restores/'),record=structuredClone(f.rt.roleRecords.get(old.identity.workId))
 const reader=new DshSessionReader(f.sdk.ctx),events=await reader.events(old.sessionId),inputs=deriveNativeInputs(events,undefined,false)
 const roles=await f.active.connection.records.list(f.prefix+'roles/')
 mark('consumer-observation',{label,record,wakes:rows,hostRestores:restores,safetyEpisodes:[...f.rt.safetyEpisodes].map(([id,value])=>({id,...value,commands:[...value.commands]})),resolvedSafetyFaultIds:[...f.rt.resolvedSafetyFaultIds],helperResponsibilities:f.rt.helperResponsibilities(record),oldInput:inputs.get(old.delivery.messageId),oldNativeTurnEnds:events.filter(e=>e.type==='turn/end'),otherRoles:roles.map(row=>({role:row.value.identity.role,sessionId:row.value.sessionId,executionId:row.value.identity.executionId}))})
 return{rows,restores,record,events,inputs}
}
try{
 f=await fixture()
 const old=await help('initial independent help')
 const originalWake=old.delivery.request.id
 const commands=[]
 for(const ordinal of [1,2]){
  const callId=await command(old,'dss_restore_host',{facts:'The isolated Host is running without business Tasks.',hypotheses:'Inspect the current Host restoration result without changing any external service.',actionsTaken:'Read the actual Helper claim and request a normal Host restore '+ordinal+'.',continuation:'Use the existing Host restoration path; this call does not claim recovery of a real user fault.'})
  const id=old.sessionId+':'+callId;commands.push(id)
  const completed=await until('exact normal Host restoration '+ordinal+' complete',async()=>{const rs=await f.active.connection.records.list(f.prefix+'host-restores/');return rs.find(row=>row.value.commandId===id&&row.value.complete)})
  check('restore '+ordinal+' has no safety ownership',completed.value.safetyFaults,undefined)
  check('restore '+ordinal+' has no safety fault IDs',completed.value.safetyFaultIds,undefined)
  mark('host-restore-completed',{ordinal,row:completed})
 }
 const before=await observe('two-complete-before-idle',old)
 check('two separate original restore rows present before idle',before.restores.filter(x=>commands.includes(x.value.commandId)).length,2)
 check('original source wake delivered',before.rows.find(x=>x.value.request.id===originalWake)?.value.delivered,true)
 check('original source signal consumed',before.rows.find(x=>x.value.request.id===originalWake)?.value.signalsConsumed,true)
 await idle(old)
 await until('both exact completed Host rows retired',async()=>!(await f.active.connection.records.list(f.prefix+'host-restores/')).some(x=>commands.includes(x.value.commandId)))
 const after=await observe('two-complete-after-idle',old)
 check('ordinary original wake retired after two accepted restores',!!after.rows.find(x=>x.value.request.id===originalWake),false)
 check('old native input really consumed',after.inputs.get(old.delivery.messageId)?.state,'consumed')
 check('original has no safety episode',f.rt.safetyEpisodes.size,0)
 const actual=f.rt.native.get(old.identity.workId).actualAgent;await f.sdk.ctx.sessions.flush(actual.session)
 const logfile=path.join(sessionDirectory(path.join(f.dir,'sessions'),actual.session.header),'session.v'+actual.session.header.version+'.jsonl')
 const firstBytes=await fs.readFile(logfile);await fs.writeFile(path.join(root,'old-after-two-restores.jsonl'),firstBytes)
 f.model.claimed.delete(old.sessionId)
 const next=await help('later independent help in same live Session')
 check('later help reuses Session',next.sessionId,old.sessionId)
 check('later help reuses execution',next.identity.executionId,old.identity.executionId)
 const during=await observe('new-help-same-session-after-claim',old)
 check('later help has a new actual wake ID',next.delivery.request.id!==originalWake,true)
 check('later actual helper responsibilities exclude old first wake',f.rt.helperResponsibilities(during.record).some(x=>x.id===originalWake),false)
 check('old consumed wake is absent during later help',during.rows.some(x=>x.value.request.id===originalWake),false)
 await idle(next)
 const final=await observe('later-help-settled',old)
 check('later plain wake is retired',final.rows.some(x=>x.value.request.id===next.delivery.request.id),false)
 check('old consumed wake remains absent',final.rows.some(x=>x.value.request.id===originalWake),false)
 check('both Host restore rows remain retired',final.restores.some(x=>commands.includes(x.value.commandId)),false)
 check('no injected failure event',trace.some(e=>e.event.startsWith('injected-')),false)
 check('old Session never given to Cleaner while reused',trace.some(e=>e.event==='retire'&&e.id===old.sessionId),false)
 await f.close()
 const stopped=trace.filter(e=>e.event==='role-persisted'&&e.record.identity.workId===old.identity.workId).at(-1)?.record
 check('real final close marks stopped',stopped?.stopped,true)
 check('real final close uses original execution',stopped?.identity.executionId,old.identity.executionId)
 const finalBytes=await fs.readFile(logfile);await fs.writeFile(path.join(root,'old-after-real-stop.jsonl'),finalBytes)
 mark('final-native',{file:logfile,bytes:finalBytes.length,sha256:hash(finalBytes),record:stopped,originalWake,commands})
}catch(error){process.exitCode=1;mark('failure',{error:String(error),stack:error.stack})}
finally{if(f)try{await f.close()}catch(error){process.exitCode=1;mark('close-failure',{error:String(error),stack:error.stack})};await fs.writeFile(path.join(root,'result-two-host-restores.json'),JSON.stringify({checks,trace,sdk:evidence()},null,2));await fs.writeFile(path.join(root,'executed-two-host-restores.mjs'),script)}
