// Actual Local FrameworkService, SDK tools, Planner completion, Recorder and Cleaner.
// Model tool choices are controlled. Ordinary dss_help reports are synthetic test
// diagnostics; no I/O fault or Task/role completion state is injected.
import fs from 'node:fs/promises'
import path from 'node:path'
const {fixture:localFixture,trace,check,checks,until:localUntil,mark,root,evidence}=await import('./helper-service-sdk.mjs')
const gitMode=process.argv.includes('--git'),fixture=gitMode?(await import('./helper-task-end-git.mjs')).fixture:localFixture
// Local CLI object transport has process-per-object overhead; test budget only.
const until=gitMode?async(name,fn)=>{const end=Date.now()+120000;for(;;){const value=await fn();if(value)return value;if(Date.now()>end)throw Error('Git experiment wait expired: '+name);await new Promise(r=>setTimeout(r,20))}}:localUntil
let f,sequence=0,heldTarget
const restoreGate=Promise.withResolvers(),secondRestoreGate=Promise.withResolvers(),blockedRestores=[]
const twoRestores=process.argv.includes('--two-restores')
const mixed=process.argv.includes('--mixed'),safetyB=process.argv.includes('--safety-b')
const wakeTask=w=>w.context?.target?.taskId??w.context?.identity?.taskId??w.context?.taskId??w.taskId
const publish=(p,text)=>gitMode?f.publish(p,text):fs.writeFile(path.join(f.dir,'business',p),text)
const read=p=>gitMode?f.read(p):fs.readFile(path.join(f.dir,'business',p),'utf8').catch(e=>{if(e.code==='ENOENT')return undefined;throw e})
const ready=async(role,taskId)=>until(role+' model ready '+(taskId??''),()=>[...f.rt.roleRecords.values()].find(r=>r.identity.role===role&&!r.stopped&&(!taskId||r.identity.taskId===taskId)&&r.delivery?.confirmed&&f.model.waiting.has(r.sessionId)))
async function command(role,name,input={},ends=false){
 const id='task-end-claim-'+(++sequence),start=trace.length;f.model.command(role.sessionId,{name,input,callId:id})
 const event=await until(name+' result',()=>trace.slice(start).find(x=>x.event==='tool'&&x.id===role.sessionId&&x.type==='tool/result'&&x.data.message.toolCallId===id))
 check(name+' succeeds '+sequence,event.data.message.isError,false)
 if(!ends)await until(name+' next model step',()=>f.model.waiting.has(role.sessionId))
 return JSON.parse(event.data.message.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'))
}
// A successful handoff concludes its tool with no value. A non-error
// completed:false is a continuation, not acceptance; follow the real notice.
async function completeTask(role,acceptance){
 const end=Date.now()+(gitMode?120000:20000)
 for(;;){
  const claimed=await command(role,'dss_claim')
  const result=await command(role,'dss_complete',{snapshotId:claimed.snapshotId,acceptance,resultPaths:[]},true)
  if(result?.completed===false){
   mark('completion-deferred',{taskId:role.identity.taskId,notifications:result.notifications})
   if(Date.now()>end)throw Error('Test completion budget expired while processing actual notifications')
   await until('deferred acceptance next model step',()=>f.model.waiting.has(role.sessionId))
   continue
  }
  const actual=JSON.parse(await read('tasks/'+role.identity.taskId+'.json'))
  check('actual Task metadata accepted '+role.identity.taskId,actual.status,'complete')
  return
 }
}
try{
 f=await fixture('task-end-helper-claims')
 // Deterministic ordering only: hold the existing background restore entry
 // before it reads/stops anything. All commands, Task terminal writes and
 // Recorder/Cleaner actions below are the real registered production paths.
 const retireTaskRuntime=f.rt.retireTaskRuntime.bind(f.rt)
 f.rt.retireTaskRuntime=async(...args)=>{const result=await retireTaskRuntime(...args);mark('actual-task-retirement-returned',{taskId:args[0].taskId});return result}
 const processRestore=f.rt.processRestore.bind(f.rt)
 f.rt.processRestore=async row=>{if(row.value.input.target?.executionId===heldTarget){if(!blockedRestores.includes(row.value.commandId))blockedRestores.push(row.value.commandId);mark('controlled-restore-scheduling-boundary',{commandId:row.value.commandId});await (blockedRestores.indexOf(row.value.commandId)===0?restoreGate:secondRestoreGate).promise}return processRestore(row)}
 const get=f.active.connection.records.get.bind(f.active.connection.records)
 f.active.connection.records.get=async function(key){const value=await get(key);if(key.startsWith(f.prefix+'restores/')&&value&&!value.complete&&new Error().stack.includes('retireTaskRuntime'))mark('actual-pending-restore-at-release',{key,value});return value}

 const tasks=path.join(f.dir,'business/tasks');await fs.mkdir(tasks,{recursive:true})
 await publish('tasks/claimA_P.md','# Controlled Task A\nComplete the independent A objective after normal Helper inspection.\n')
 const a=await ready('Planner');await command(a,'dss_claim')
 await command(a,'dss_help',{facts:'Controlled diagnostic request A: inspect this isolated task record. No I/O fault is injected.'})
 let helper=await ready('Helper');await command(helper,'dss_claim')
 await publish('tasks/claimB_P.md','# Controlled Task B\nKeep the independent B objective running while A ends.\n')
 const b=await until('second actual Planner ready',()=>[...f.rt.roleRecords.values()].find(r=>r.identity.role==='Planner'&&r.identity.taskId!==a.identity.taskId&&!r.stopped&&f.model.waiting.has(r.sessionId)))
 await command(b,'dss_claim')
 if(safetyB){
  f.model.waiting.get(b.sessionId).reject(new Error('Controlled actual model source failure B'))
  await until('actual B SDK error captured',()=>[...f.rt.safetyEpisodes.values()].some(e=>(e.fault.taskId??e.fault.identity?.taskId)===b.identity.taskId))
 }else await command(b,'dss_help',{facts:'Controlled diagnostic request B: inspect B without completing it. No I/O fault is injected.'})
 await until('B actual Helper signal publication',async()=>{const rows=await f.active.connection.records.list(f.prefix+'wakes/');const r=rows.find(r=>wakeTask(r.value.request)===b.identity.taskId&&r.value.helperSignal);return r&&read(r.value.helperSignal).then(value=>value!==undefined)})
 const bClaim=mixed?undefined:await command(helper,'dss_claim')
 if(bClaim)check('B real notification is returned',bClaim.helperNotifications.some(w=>wakeTask(w)===b.identity.taskId),true)
 await command(a,'dss_help',{facts:'Controlled later request A: record inspection before actual A completion.'})
 await until('later A actual Helper signal publication',async()=>{const rows=await f.active.connection.records.list(f.prefix+'wakes/');const r=rows.find(r=>r.value.request.context?.target?.taskId===a.identity.taskId&&r.value.request.context?.facts?.startsWith('Controlled later')&&r.value.helperSignal);return r&&read(r.value.helperSignal).then(value=>value!==undefined)})
 const aClaim=await command(helper,'dss_claim')
 check('later A real notification is returned',aClaim.helperNotifications.some(w=>w.context?.target?.taskId===a.identity.taskId),true)
 const before=structuredClone(f.rt.roleRecords.get(helper.identity.workId).notificationClaims)
 const aKeys=Object.entries(before).filter(([,c])=>c.helperWakes?.length&&(mixed?c.helperWakes.some(w=>w.context?.target?.taskId===a.identity.taskId):c.helperWakes.every(w=>w.context?.target?.taskId===a.identity.taskId))).map(([id])=>id)
 const bKeys=Object.entries(before).filter(([,c])=>c.helperWakes?.some(w=>wakeTask(w)===b.identity.taskId)).map(([id])=>id)
 check('one A claim selected',aKeys.length,1);check('one B claim selected',bKeys.length,1)
 if(mixed)check('actual one claim contains two Tasks',aKeys[0],bKeys[0])
 const logs=[...new Set(aClaim.helperNotifications.map(w=>w.context?.helperDebugPath).filter(Boolean))]
 for(const log of logs){const view=await command(helper,'dss_snapshot');await command(helper,'dss_record',{snapshotId:view.snapshotId,path:log,text:'Controlled diagnostic inspection recorded. This log is permanent; no completion is inferred from Helper idle.\n',append:true})}
 if(false&&!safetyB&&!process.argv.includes('--helper-active')){f.model.command(helper.sessionId,'idle');await until('Helper idle',()=>f.rt.native.get(helper.identity.workId)?.observe().state==='idle')}
 check('idle does not erase A claim',!!f.rt.roleRecords.get(helper.identity.workId).notificationClaims[aKeys[0]],true)
 check('idle does not erase B claim',!!f.rt.roleRecords.get(helper.identity.workId).notificationClaims[bKeys[0]],true)
 await completeTask(a,'Controlled independent A objective actually accepted via registered tool.')
 const recorder=await ready('Recorder',a.identity.taskId),archive=await command(recorder,'dss_claim')
 heldTarget=a.identity.executionId
 await command(helper,'dss_restore',{target:a.identity,facts:'Task A was accepted normally; inspect the exact prior Planner release.',hypotheses:'The accepted Task is terminal; no execution failure is asserted.',actionsTaken:'Read the original Helper-delivered Planner identity and actual accepted Task.',continuation:'Complete the original exact restoration disposition without reopening terminal business.'})
 const restoreRow=(await f.active.connection.records.list(f.prefix+'restores/')).find(r=>r.value.input.target?.executionId===a.identity.executionId)
 check('exact normal restore accepted',restoreRow?.value.complete,false)
 let secondRestoreRow
 if(twoRestores){
  await command(helper,'dss_restore',{target:a.identity,facts:'A second explicit request targets the same real terminal Planner.',hypotheses:'No fault is invented; both accepted requests keep their own original responsibility.',actionsTaken:'Read the already accepted terminal Task and original Planner identity.',continuation:'Finish this original request through normal terminal disposition.'})
  secondRestoreRow=(await f.active.connection.records.list(f.prefix+'restores/')).find(r=>r.key!==restoreRow.key&&r.value.input.target?.executionId===a.identity.executionId)
  check('second original restore accepted',secondRestoreRow?.value.complete,false)
 }
 mark('restore-before-recorder-handoff',{row:restoreRow,second:secondRestoreRow})
 await command(recorder,'dss_recorder_save',{snapshotId:archive.snapshotId,outputs:[{path:archive.archiveRecordsPath,text:'# Task A result\nActual Planner acceptance and Recorder handoff.\n'}],retainedPaths:[]},true)
 await until('real A runtime retirement',()=>![...f.rt.roleRecords.values()].some(r=>r.identity.taskId===a.identity.taskId))
 await until('original Task retirement pass returns',()=>trace.some(e=>e.event==='actual-task-retirement-returned'&&e.taskId===a.identity.taskId))
 restoreGate.resolve()
 await until('original restore finishes after release',async()=>!await f.active.connection.records.get(restoreRow.key))
 if(twoRestores){
  await until('second original processing begins',()=>blockedRestores.length===2)
  check('first completion does not retire claims owned by still-pending second request',!!f.rt.roleRecords.get(helper.identity.workId)?.notificationClaims?.[aKeys[0]],true)
  check('second original remains incomplete',(await f.active.connection.records.get(secondRestoreRow.key))?.complete,false)
  secondRestoreGate.resolve()
  await until('second original restore finishes',async()=>!await f.active.connection.records.get(secondRestoreRow.key))
 }
 check('original pending restore actually observed during retirement',trace.some(e=>e.event==='actual-pending-restore-at-release'&&e.key===restoreRow.key),true)
 mark('restore-after-release',{pendingObserved:true,remainingHelperClaims:f.rt.roleRecords.get(helper.identity.workId)?.notificationClaims})
 await until('A-only claim retired',()=>!f.rt.roleRecords.get(helper.identity.workId)?.notificationClaims?.[aKeys[0]])
 const after=f.rt.roleRecords.get(helper.identity.workId),persisted=await f.row(helper)
 check('A-only claim absent on disk',persisted.notificationClaims?.[aKeys[0]],undefined)
 if(!mixed)check('B original claim bytes unchanged',JSON.stringify(after.notificationClaims[bKeys[0]]),JSON.stringify(before[bKeys[0]]))
 else {
  check('no stored mixed-claim copies of finished A',Object.values(persisted.notificationClaims??{}).some(c=>c.helperWakes?.some(w=>w.context?.target?.taskId===a.identity.taskId)),false)
  const pending=await f.active.connection.records.list(f.prefix+'wakes/')
  check('B remains in its original consumed WakeRecord',pending.some(r=>r.value.signalsConsumed&&wakeTask(r.value.request)===b.identity.taskId),true)
 }
 check('B still executing',f.rt.roleRecords.get(b.identity.workId)?.identity.executionId,b.identity.executionId)
 check('B context remains available',f.rt.helperResponsibilities(after).some(w=>wakeTask(w)===b.identity.taskId),true)
 for(const log of logs)check('long-term Debug retained '+log,(await read(log)).includes('inspection recorded'),true)
 mark('task-end-claims-result',{mode:gitMode?'git-local-bare':'local',gitCost:f.gitEvents?{fetchHead:f.gitEvents.filter(e=>e.op==='fetchHead').length,push:f.gitEvents.filter(e=>e.op==='push').length}:undefined,a:a.identity,b:b.identity,aKeys,bKeys,before,after:after.notificationClaims,logs})
 await fs.writeFile(path.join(root,'task-end-claims-evidence.json'),JSON.stringify({checks,trace,limits:gitMode?'Linux actual Runtime/Host/SDK/Recorder/Cleaner and local bare Git object/CAS transport. No Service Git login, Dulwich, online Git or Windows. Model choices controlled; no I/O fault or seeded completion.':'Linux Local actual FrameworkService/SDK/Host/Recorder/Cleaner. Model choices controlled; explicit scheduling barrier at original processRestore entry. No I/O fault or seeded completion. Mixed/cold coverage only when selected; Safety closure remains unfinished.'},null,2))
 console.log(JSON.stringify({status:'passed',checks:checks.length,checksDetail:checks,...evidence()},null,2))
}catch(error){console.error(error);await fs.writeFile(path.join(root,'task-end-claims-failure.json'),JSON.stringify({error:String(error),checks,trace},null,2));process.exitCode=1}
finally{restoreGate.resolve();secondRestoreGate.resolve();await f?.close()}
