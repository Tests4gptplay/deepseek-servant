// Actual Service/Host/SDK AgentLoop; only model decisions and model fault source
// are controlled. No direct Runtime.error, SafetyNet.capture/resolved, role row
// seeding, or I/O failure monkey-patch is used by this scenario.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
const {fixture,trace,check,checks,until,mark,results,root,evidence}=await import('./helper-service-sdk.mjs')
let f,seq=0
const restoreOnly=process.argv.includes('--restore-only'),hostRestore=process.argv.includes('--host-restore')
const events=[]
const role=(name)=>[...f.rt.roleRecords.values()].find(r=>r.identity.role===name&&!r.stopped)
async function ready(name){return until(name+' actual model ready',()=>{const r=role(name);return r?.delivery?.confirmed&&f.model.waiting.has(r.sessionId)?structuredClone(r):undefined})}
async function command(r,name,input={}) {
 const callId='native-safety-'+(++seq),begin=trace.length
 f.model.command(r.sessionId,{name,input,callId})
 const result=await until(name+' SDK result',()=>trace.slice(begin).find(e=>e.event==='tool'&&e.id===r.sessionId&&e.type==='tool/result'&&e.data.message.toolCallId===callId))
 check(name+' actual registered tool succeeds '+seq,result.data.message.isError,false)
 await until('model ready after '+callId,()=>f.model.waiting.has(r.sessionId))
 const blocks=result.data.message.content??[]
 const value=blocks.filter(c=>c.type==='text').map(c=>c.text).join('\n')
 return {callId,value:JSON.parse(value)}
}
async function providerFault(planner,label) {
 const before=events.length,oldIds=new Set(f.rt.safetyEpisodes.keys()),d=f.model.waiting.get(planner.sessionId)
 assert(d,'Actual Planner LLM stream has begun')
 d.reject(new Error('Controlled provider fault: unavailable model response'))
 await until(label+' actual SDK agent/error',()=>events.slice(before).find(e=>e.type==='agent/error'&&e.sessionId===planner.sessionId))
 return until(label+' automatic Service Safety episode',()=>[...f.rt.safetyEpisodes.values()].find(e=>!oldIds.has(e.fault.id)&&e.fault.identity?.executionId===planner.identity.executionId))
}
try {
 f=await fixture('safety-native-continuation')
 f.sdk.ctx.on('session/event',(session,event)=>{if(['turn/start','turn/end','user/message','input/consume'].includes(event.type))events.push({type:event.type,sessionId:String(session.id),data:event.data})})
 f.sdk.ctx.on('agent/error',event=>events.push({type:'agent/error',sessionId:String(event.agent.session.id),turn:event.turn,error:event.error.message}))
 const source=path.join(f.dir,'business','tasks','SafetyContinuity_P.md')
 await fs.mkdir(path.dirname(source),{recursive:true})
 await fs.writeFile(source,'# Actual isolated Planner responsibility\nKeep this unfinished business task and preserve its records. Exercise the existing Helper restoration after the controlled model source reports failure.\n')
 const original=await ready('Planner')
 await command(original,'dss_claim')
 const first=await providerFault(original,'first')
 const helper=await ready('Helper'),claim=await command(helper,'dss_claim')
 check('first fault belongs to actual Task',first.fault.taskId,original.identity.taskId)
 check('first claim contains actual fault',JSON.stringify(claim.value).includes(first.fault.id),true)
 const snapshot=await command(helper,'dss_snapshot'),log= snapshot.value.helperRecordPath
 check('actual Helper receives Task debug path',log.includes('/tasks/'+original.identity.taskId+'/'),true)
 const beforeContinuation=events.length
 const restored=await command(helper,hostRestore?'dss_restore_host':'dss_restore',{...(!hostRestore?{target:original.identity}:{}),facts:'The actual SDK AgentLoop reported a controlled model provider fault for this Planner.',hypotheses:'This validation controls the model error source, not a real user outage.',actionsTaken:'Read original Task and actual fault identity; preserve business records and use existing restoration.',continuation:'Continue the same original Task through its existing original input and retained records.'})
 check('request only reports arranged',restored.value.arranged,true)
 let continued=await until('actual restored Planner new native turn',()=>{const r=role('Planner');return r&&(hostRestore?events.slice(beforeContinuation).some(e=>e.type==='turn/start'&&e.sessionId===r.sessionId):r.identity.executionId!==original.identity.executionId)&&f.model.waiting.has(r.sessionId)?structuredClone(r):undefined})
 check('continued Planner keeps actual Task',continued.identity.taskId,original.identity.taskId)
 check('actual replacement native turn was started',events.some(e=>e.type==='turn/start'&&e.sessionId===continued.sessionId),true)
 check('actual replacement model stream reached',f.model.calls.some(c=>c.sessionId===continued.sessionId),true)
 await until('actual original restore complete',async()=>{const rows=await f.active.connection.records.list(f.prefix+(hostRestore?'host-restores/':'restores/'));return rows.some(r=>r.value.complete&&(hostRestore||(r.value.resolvedTarget??r.value.input.target)?.executionId===original.identity.executionId))})
 const repaired=await command(helper,'dss_snapshot')
 await command(helper,'dss_record',{snapshotId:repaired.value.snapshotId,path:log,append:true,text:'First repair: preserved original Task and used dss_restore. Actual new Planner native turn and model stream are observed.\n',...(!restoreOnly?{repairAttempt:{faultId:first.fault.id,actionsTaken:'Requested original restore and observed actual Planner continuation',outcome:'repaired',result:'Original Task has actually resumed in its new native turn'}}:{})})
 f.model.command(helper.sessionId,'idle')
 await until('first Helper actual round finished',()=>f.rt.native.get(helper.identity.workId)?.observe().state==='idle')
 if(process.argv.includes('--cold')){
  const priorSession=continued.sessionId
  await f.close();f=await fixture('safety-native-continuation',true)
  f.sdk.ctx.on('session/event',(session,event)=>{if(['turn/start','turn/end','user/message','input/consume'].includes(event.type))events.push({type:event.type,sessionId:String(session.id),data:event.data})})
  f.sdk.ctx.on('agent/error',event=>events.push({type:'agent/error',sessionId:String(event.agent.session.id),turn:event.turn,error:event.error.message}))
  continued=await ready('Planner')
  check('normal Service restart retained actual Task',continued.identity.taskId,original.identity.taskId)
  check('normal Service restart retains original native context',!!priorSession&&f.model.calls.some(c=>c.sessionId===continued.sessionId),true)
 }
 const beforeSecond=trace.length,second=await providerFault(continued,'second')
 check('actual repeated fault has a new occurrence',second.fault.id===first.fault.id,false)
 check('same original Task',second.fault.taskId,first.fault.taskId)
 check('same failure fingerprint',second.fault.fingerprint,first.fault.fingerprint)
 const nextHelper=await ready('Helper'),secondClaim=await command(nextHelper,'dss_claim')
 check('second actual claim contains repeated fault',JSON.stringify(secondClaim.value).includes(second.fault.id),true)
 check('second claim returns same Task log',JSON.stringify(secondClaim.value).includes(log),true)
 const originalStream=f.model.stream.bind(f.model),foregroundResults=[];let foregroundStage=0
 f.sdk.ctx.on('session/event',(session,event)=>{
  if(event.type==='tool/result'&&role('Foreground')?.sessionId===String(session.id))foregroundResults.push(event.data.message)
 })
 f.model.stream=async function*(o){
  if(!o.tools.some(t=>t.name==='dss_task_restore')){yield*originalStream(o);return}
  const previous=foregroundResults.at(-1)
  if(previous?.isError)throw Error('Actual Foreground tool failed: '+JSON.stringify(previous))
  let name,input
  if(foregroundStage===0){name='dss_claim';input={}}
  else if(foregroundStage===1){
   const claim=JSON.parse(previous.content.find(c=>c.type==='text').text)
   check('Foreground actual claim supplies precise Task log',claim.helperReports?.some(r=>r.path===log),true)
   name='dss_read';input={snapshotId:claim.snapshotId,path:claim.helperReports.find(r=>r.path===log).path}
  }else if(foregroundStage===2){
   check('Foreground actual read contains second fault diagnosis',JSON.stringify(previous).includes('Second actual same Task failure'),true)
   name='dss_snapshot';input={}
  }else if(foregroundStage===3){name='dss_conversation_send';input={id:'safety-final-user-report',text:'The original Task resumed, but its model provider failed again. Helper requests user attention. Diagnosis: '+log,responsePhase:'final',intent:'human'}}
  else{yield{type:'text-delta',index:0,text:'Final report published.'};yield{type:'finish',reason:'stop'};return}
  foregroundStage++;yield{type:'tool-call-delta',index:0,name,id:'foreground-safety-'+foregroundStage,argumentsDelta:JSON.stringify(input)};yield{type:'finish',reason:'tool-calls'}
 }
 const finalView=await command(nextHelper,'dss_snapshot')
 await command(nextHelper,'dss_record',{snapshotId:finalView.value.snapshotId,path:log,append:true,text:'Second actual same Task failure after original continuation. Helper judges the controlled provider requires user attention; original Task records remain preserved.\n',notifyForeground:true,repairAttempt:{faultId:second.fault.id,actionsTaken:'Inspected actual second provider error and Task continuation history',outcome:'attempted-not-repaired',result:'Provider requires user attention; no successful repair is claimed'}})
 const userReport=await until('actual Foreground final user message',async()=>{
  const access=await f.service.access('local');return access.conversation.read('safety-final-user-report')
 })
 check('actual final conversation message references Task log',userReport.text.includes(log),true)
 await until('actual final Foreground tool success',()=>foregroundResults.some(r=>r.toolCallId==='foreground-safety-4'&&!r.isError))
 check('Foreground consumed exact report signal', (await fs.readdir(path.join(f.dir,'business','state'))).some(p=>p.startsWith('Foreground_Helper_Report_')),false)
 const text=await fs.readFile(path.join(f.dir,'business',log),'utf8')
 check('first diagnostic retained',text.includes('First repair:'),true)
 check('second diagnostic retained',text.includes('Second actual same Task failure'),true)
 check('original business source retained',await fs.readFile(source,'utf8').then(s=>s.includes('unfinished business task')),true)
 mark('native-safety-evidence',{original,continued,first:first.fault,second:second.fault,log,events,checks})
 console.log(JSON.stringify({status:'passed',checks:checks.length,...evidence(),limits:'Linux actual FrameworkService, Host, actual SDK AgentLoop and registered tools; controlled LLM adapter throws a deliberate provider error twice. This proves the original Task continuation/error production path for the required Safety rule, not a natural provider outage, natural model decisions, Git transport, Windows installation, natural-language quality, or D024 cleanup.'},null,2))
} catch(error){process.exitCode=1;mark('failure',{error:String(error),stack:error.stack});throw error}
finally{if(f)mark('final-existing-state',{restores:await f.active.connection.records.list(f.prefix+'restores/'),episodes:[...f.rt.safetyEpisodes].map(([id,e])=>({id,fault:e.fault,settled:e.settled,commands:[...e.commands]}))});await fs.writeFile(path.join(root,'native-safety-continuation.json'),JSON.stringify({checks,events,trace,sdk:evidence()},null,2));await f?.close()}
