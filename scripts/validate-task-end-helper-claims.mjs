// Actual Local FrameworkService, SDK tools, Planner completion, Recorder and Cleaner.
// Model tool choices are controlled. Ordinary dss_help reports are synthetic test
// diagnostics; no I/O fault or Task/role completion state is injected.
import fs from 'node:fs/promises'
import path from 'node:path'
const {fixture:localFixture,trace,check,checks,until:localUntil,mark,root,evidence}=await import('./helper-service-sdk.mjs')
const gitMode=process.argv.includes('--git'),fixture=gitMode?(await import('./helper-task-end-git.mjs')).fixture:localFixture
// Local CLI object transport has process-per-object overhead; test budget only.
const until=gitMode?async(name,fn)=>{const end=Date.now()+120000;for(;;){const value=await fn();if(value)return value;if(Date.now()>end)throw Error('Git experiment wait expired: '+name);await new Promise(r=>setTimeout(r,20))}}:localUntil
let f,sequence=0
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
 if(!safetyB&&!process.argv.includes('--helper-active')){f.model.command(helper.sessionId,'idle');await until('Helper idle',()=>f.rt.native.get(helper.identity.workId)?.observe().state==='idle')}
 check('idle does not erase A claim',!!f.rt.roleRecords.get(helper.identity.workId).notificationClaims[aKeys[0]],true)
 check('idle does not erase B claim',!!f.rt.roleRecords.get(helper.identity.workId).notificationClaims[bKeys[0]],true)
 await completeTask(a,'Controlled independent A objective actually accepted via registered tool.')
 const recorder=await ready('Recorder',a.identity.taskId),archive=await command(recorder,'dss_claim')
 await command(recorder,'dss_recorder_save',{snapshotId:archive.snapshotId,outputs:[{path:archive.archiveRecordsPath,text:'# Task A result\nActual Planner acceptance and Recorder handoff.\n'}],retainedPaths:[]},true)
 await until('real A runtime retirement',()=>![...f.rt.roleRecords.values()].some(r=>r.identity.taskId===a.identity.taskId))
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
 if(safetyB){
  const view=await command(helper,'dss_snapshot'),fault=view.safetyFaults.find(x=>(x.taskId??x.identity?.taskId)===b.identity.taskId)
  check('unfinished B Safety responsibility available after A cleanup',!!fault,true)
  const restored=await command(helper,'dss_restore_host',{facts:'Actual B SDK model stream error remains after unrelated A completed.',hypotheses:'Controlled model source; preserve B business state and real diagnostics.',actionsTaken:'Read remaining B fault and original Task log.',continuation:'Use original overall Host restoration so B can continue; preserve completed A results.'})
  check('original Host restore remains arranged',restored.arranged,true)
  const initialRestore=(await f.active.connection.records.list(f.prefix+'host-restores/')).find(r=>r.value.safetyFaultIds?.includes(fault.id))
  check('B Host restoration log follows B, not the initial A binding',initialRestore.value.debugPath.includes('/tasks/'+b.identity.taskId+'/'),true)

  const resumed=await ready('Planner',b.identity.taskId)
  await until('original Host restoration completes',async()=>(await f.active.connection.records.list(f.prefix+'host-restores/')).some(r=>r.value.complete))
  check('B actually continues after Host restoration',f.model.waiting.has(resumed.sessionId),true)
  const oldFaultIds=new Set(f.rt.safetyEpisodes.keys())
  f.model.waiting.get(resumed.sessionId).reject(new Error('Controlled actual model source failure B'))
  const second=await until('continued B actual same fault captured',()=>[...f.rt.safetyEpisodes.values()].find(e=>!oldFaultIds.has(e.fault.id)&&(e.fault.taskId??e.fault.identity?.taskId)===b.identity.taskId))
  await until('B second actual Helper signal published',async()=>{const rows=await f.active.connection.records.list(f.prefix+'wakes/');const row=rows.find(r=>r.value.safetyFaults?.some(x=>x.id===second.fault.id)&&r.value.helperSignal);return row&&read(row.value.helperSignal).then(v=>v!==undefined)})
  const next=await command(helper,'dss_claim')
  check('same fault second occurrence remains claimable',JSON.stringify(next).includes(second.fault.id),true)
  const nextView=await command(helper,'dss_snapshot'),bLog=next.helperNotifications.find(w=>wakeTask(w)===b.identity.taskId)?.context.helperDebugPath
  if(process.argv.includes('--complete-safety')){
   await command(helper,'dss_restore_host',{facts:'B actually continued and then the same controlled model source failed a second time.',hypotheses:'Controlled repeat; retain B records and original diagnostics.',actionsTaken:'Inspect actual second error and choose original Host overall restoration again.',continuation:'Continue B and verify its actual accepted result before final release.'})
   const finalB=await ready('Planner',b.identity.taskId)
   await until('second Host restore complete',async()=>(await f.active.connection.records.list(f.prefix+'host-restores/')).filter(r=>r.value.complete).length>=2)
   const repairedView=await command(helper,'dss_snapshot')
   await command(helper,'dss_record',{snapshotId:repairedView.snapshotId,path:bLog,text:'Second repair: actual original B model turn continued again; record observed continuation before Task acceptance.\n',append:true,repairAttempt:{faultId:second.fault.id,actionsTaken:'Original Host restore completed and B actual model stream resumed.',outcome:'repaired',result:'Actual B continuation observed; Task acceptance follows.'}})
   await completeTask(finalB,'Actual B objective accepted after its second original restoration.')
   const rr=await ready('Recorder',b.identity.taskId),av=await command(rr,'dss_claim')
   await command(rr,'dss_recorder_save',{snapshotId:av.snapshotId,outputs:[{path:av.archiveRecordsPath,text:'# B actual result\nB accepted after controlled repeated model fault and real original restoration.\n'}],retainedPaths:[]},true)
   await until('all resolved B diagnostic wakes retire at actual Task end',async()=>!(await f.active.connection.records.list(f.prefix+'wakes/')).some(r=>wakeTask(r.value.request)===b.identity.taskId))
   check('B first and second temporary wake gone',(await f.active.connection.records.list(f.prefix+'wakes/')).some(r=>wakeTask(r.value.request)===b.identity.taskId),false)
   check('second important Debug remains',(await read(bLog)).includes('Second repair'),true)
  }else{
  await command(helper,'dss_record',{snapshotId:nextView.snapshotId,path:bLog,text:'B actually continued through Host restore, then the same controlled model source failed again. Second Helper assessment needs user assistance.\n',append:true,notifyForeground:true,repairAttempt:{faultId:second.fault.id,actionsTaken:'Original Host restore completed and B actually ran again; inspected actual second fault.',outcome:'attempted-not-repaired',result:'User assistance requested for the actual repeated controlled model fault.'}})
  check('B final diagnostic remains in its own permanent log',(await read(bLog)).includes('Second Helper assessment'),true)
  }
 }
 if(process.argv.includes('--cold')){
  const pendingId=before[bKeys[0]].helperWakes.find(w=>wakeTask(w)===b.identity.taskId).id
  const previousHelperFile=f.file(f.rt.roleRecords.get(helper.identity.workId))
  await f.close();f=await fixture('task-end-helper-claims',true)
  const nextB=await ready('Planner',b.identity.taskId)
  await until('cold original Helper responsibility restored',()=>[...f.rt.roleRecords.values()].some(r=>r.identity.role==='Helper'&&f.rt.helperResponsibilities(r).some(w=>w.id===pendingId)))
  check('normal restart retains B own task',nextB.identity.taskId,b.identity.taskId)
  const coldHelper=await ready('Helper'),coldClaim=await command(coldHelper,'dss_claim')
  if(process.argv.includes('--helper-active')&&!process.argv.includes('--helper-retirement'))check('interrupted Helper keeps original native evidence',await fs.access(previousHelperFile).then(()=>true,()=>false),true)
  if(process.argv.includes('--helper-retirement')){
   await until('old replaced Helper native retirement',()=>fs.access(previousHelperFile).then(()=>false,e=>{if(e.code==='ENOENT')return true;throw e}))
   check('old Helper was replaced, not merely idle',coldHelper.sessionId===helper.sessionId,false)
  }
  const startupChecks=f.rt.helperResponsibilities(f.rt.roleRecords.get(coldHelper.identity.workId)).filter(w=>w.reason==='startup-recovery'&&w.context?.targets)
  check('actual startup check follows B Task',startupChecks.some(w=>w.taskId===b.identity.taskId),true)
  check('startup check supplies B permanent Debug folder',startupChecks.filter(w=>w.taskId===b.identity.taskId).every(w=>w.context.helperDebugPath.includes('/tasks/'+b.identity.taskId+'/')),true)
  await completeTask(nextB,'Controlled B objective completed after ordinary Service restart.')
  const recorderB=await ready('Recorder',b.identity.taskId),archiveB=await command(recorderB,'dss_claim')
  await command(recorderB,'dss_recorder_save',{snapshotId:archiveB.snapshotId,outputs:[{path:archiveB.archiveRecordsPath,text:'# Task B result\nB completed independently after restart.\n'}],retainedPaths:[]},true)
  await until('B original Helper wake retired at actual B end',async()=>!(await f.active.connection.records.list(f.prefix+'wakes/')).some(r=>r.value.request.id===pendingId))
  check('B original Helper wake absent after true B end',(await f.active.connection.records.list(f.prefix+'wakes/')).some(r=>r.value.request.id===pendingId),false)
  await until('B startup Helper check retires at actual B end',async()=>!(await f.active.connection.records.list(f.prefix+'wakes/')).some(r=>r.value.request.role==='Helper'&&wakeTask(r.value.request)===b.identity.taskId))
  check('B startup check is not kept as Host history',(await f.active.connection.records.list(f.prefix+'wakes/')).some(r=>r.value.request.role==='Helper'&&wakeTask(r.value.request)===b.identity.taskId),false)
 }
 mark('task-end-claims-result',{mode:gitMode?'git-local-bare':'local',gitCost:f.gitEvents?{fetchHead:f.gitEvents.filter(e=>e.op==='fetchHead').length,push:f.gitEvents.filter(e=>e.op==='push').length}:undefined,a:a.identity,b:b.identity,aKeys,bKeys,before,after:after.notificationClaims,logs})
 await fs.writeFile(path.join(root,'task-end-claims-evidence.json'),JSON.stringify({checks,trace,limits:gitMode?'Linux actual Runtime/Host/SDK/Recorder/Cleaner and local bare Git object/CAS transport. No Service Git login, Dulwich, online Git or Windows. Model choices controlled; no I/O fault or seeded completion.':'Linux Local actual FrameworkService/SDK/Host/Recorder/Cleaner. Model choices controlled, no I/O fault or seeded completion. Mixed/cold coverage only when selected; Safety closure remains unfinished.'},null,2))
 console.log(JSON.stringify({status:'passed',checks:checks.length,checksDetail:checks,...evidence()},null,2))
}catch(error){console.error(error);await fs.writeFile(path.join(root,'task-end-claims-failure.json'),JSON.stringify({error:String(error),checks,trace},null,2));process.exitCode=1}
finally{await f?.close()}
